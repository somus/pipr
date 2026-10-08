import { z } from "zod";

/** What happened to one finding; see Finding Outcome in the product glossary. */
export const findingOutcomeKinds = [
  "proposed",
  "dropped",
  "published",
  "carried",
  "outdated",
  "fixed",
  "still-valid",
  "resolved-by-human",
  "replied",
] as const;

/** Content-free reason a finding was dropped before or during publication. */
export const findingDropCodes = [
  "path-scope",
  "excluded-file",
  "unknown-range",
  "range-mismatch",
  "path-mismatch",
  "side-mismatch",
  "inverted-lines",
  "out-of-range",
  "duplicate",
  "unpublishable-fix",
  "cap",
  "inline-cap",
  "empty-body",
  "schema-invalid",
] as const;

/**
 * Repository permission of the human who replied to a finding: a host permission, `author` for the
 * change request author, `unchecked` when configuration allows any actor, or `unknown`.
 */
const findingActorPermissions = [
  "none",
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
  "author",
  "unchecked",
  "unknown",
] as const;

export type FindingOutcomeKind = (typeof findingOutcomeKinds)[number];
export type FindingDropCode = (typeof findingDropCodes)[number];
export type FindingActorPermission = (typeof findingActorPermissions)[number];

/**
 * Whether the execution's code host reports native thread resolution. Only hosts where it is
 * `available` can observe `resolved-by-human`; stats leave the others out of dismissal rates.
 */
const findingThreadResolutions = ["available", "unavailable"] as const;

export type FindingThreadResolution = (typeof findingThreadResolutions)[number];

const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const tokenPattern = /^[\w.:/@+-]+$/;
const token = (max: number) =>
  z.string().min(1).max(max).regex(tokenPattern, "must be a single token without whitespace");
const singleLinePattern = /^[^\p{Cc}]+$/u;
const singleLine = (max: number) =>
  z.string().min(1).max(max).regex(singleLinePattern, "must be a single line");
/** Provider model ids such as `deepseek/deepseek-v4.1-flash` or `claude-opus-5-5[1m]`. */
const modelPattern = /^[^\s\p{Cc}]+$/u;

const attributionLimits = { agent: 200, model: 200, facetKey: 100, facetValue: 100, facets: 32 };

const agentName = singleLine(attributionLimits.agent);
const modelName = z
  .string()
  .min(1)
  .max(attributionLimits.model)
  .regex(modelPattern, "must be one line without whitespace");
const facetKey = token(attributionLimits.facetKey);
const facetValue = singleLine(attributionLimits.facetValue);

/**
 * Bounds attribution to what a public event accepts: agent and facet values become single lines,
 * the model loses whitespace, values are truncated to their limits, and facets with invalid keys
 * or empty values are dropped. Normalizing the same input always yields the same values.
 */
export function normalizeFindingAttribution(attribution: {
  agent?: string;
  model?: string;
  facets?: Readonly<Record<string, string>>;
}): { agent?: string; model?: string; facets: Record<string, string> } {
  const agent = boundedLine(attribution.agent ?? "", attributionLimits.agent);
  const model = bounded(
    (attribution.model ?? "").trim().replace(/[\s\p{Cc}]+/gu, "-"),
    attributionLimits.model,
  );
  const facets = Object.entries(attribution.facets ?? {}).flatMap(([key, value]) => {
    const line = boundedLine(value, attributionLimits.facetValue);
    return facetKey.safeParse(key).success && line ? [[key, line] as const] : [];
  });
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    facets: Object.fromEntries(facets.slice(0, attributionLimits.facets)),
  };
}

function boundedLine(value: string, max: number): string {
  return bounded(value.replace(/[\s\p{Cc}]+/gu, " ").trim(), max).trimEnd();
}

/** Truncates to `max` UTF-16 units without leaving half a surrogate pair. */
function bounded(value: string, max: number): string {
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

/** Same identifier the inline comment marker carries, normally `fnd_` plus 16 hex digits. */
const findingIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);

/** One content-free Finding Outcome event; safe for public metadata. */
export const findingOutcomeEventSchema = z
  .strictObject({
    /**
     * sha256 of `findingId|kind|headSha|workId|reasonCode`, stable across reruns of the same work.
     * Outcomes tied to a host marker (Pipr resolutions, verifier replies, human resolutions) hash
     * `findingId|kind|anchor:<anchor>` instead, so a later run that rebuilds the outcome from the
     * marker produces the same eventId as the run that acted.
     */
    eventId: sha256,
    findingId: findingIdSchema,
    kind: z.enum(findingOutcomeKinds),
    reasonCode: z.enum(findingDropCodes).optional(),
    actorPermission: z.enum(findingActorPermissions).optional(),
    workId: token(200),
    executionId: z.string().regex(/^[a-f0-9]{32}$/),
    headSha: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._-]+$/),
    configHash: sha256.optional(),
    /** Name of the agent that produced the finding. */
    agent: agentName.optional(),
    /** Model that produced the finding. */
    model: modelName.optional(),
    /** Declared enum field values of the finding. */
    facets: z
      .record(facetKey, facetValue)
      .refine(
        (facets) => Object.keys(facets).length <= attributionLimits.facets,
        "at most 32 facets",
      ),
    at: z.string().datetime({ offset: true }),
    /** Emission order within one execution. */
    sequence: count,
  })
  .superRefine((event, context) => {
    if ((event.kind === "dropped") !== (event.reasonCode !== undefined)) {
      context.addIssue({ code: "custom", message: "reasonCode is required only on dropped" });
    }
    if ((event.kind === "replied") !== (event.actorPermission !== undefined)) {
      context.addIssue({ code: "custom", message: "actorPermission is required only on replied" });
    }
  });

export type FindingOutcomeEvent = z.infer<typeof findingOutcomeEventSchema>;

/** Diagnostic location and content of one finding, keyed by finding ID in the diagnostic ledger. */
const findingEvidenceSchema = z.strictObject({
  path: z.string().min(1),
  rangeId: z.string().min(1),
  side: z.enum(["LEFT", "RIGHT"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  body: z.string(),
  suggestedFix: z.string().optional(),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
});

export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;

const ledgerEvents = z.array(findingOutcomeEventSchema).max(10_000);
/** Thread resolution support of the execution's code host; absent for local runs. */
const ledgerThreadResolution = z.enum(findingThreadResolutions).optional();

/** Public `ledger` artifact: Finding Outcome events without diagnostic content. */
export const findingLedgerSchema = z.strictObject({
  formatVersion: z.literal(1),
  threadResolution: ledgerThreadResolution,
  events: ledgerEvents,
});

export type FindingLedger = z.infer<typeof findingLedgerSchema>;

/** Diagnostic `ledger` artifact: the public events plus evidence for each finding. */
export const diagnosticFindingLedgerSchema = z.strictObject({
  formatVersion: z.literal(1),
  threadResolution: ledgerThreadResolution,
  events: ledgerEvents,
  evidence: z.record(findingIdSchema, findingEvidenceSchema),
});

export type DiagnosticFindingLedger = z.infer<typeof diagnosticFindingLedgerSchema>;

/** Learning label of an exported finding: fixed and still-valid are positive, dismissed negative. */
const findingDatasetLabels = ["fixed", "still-valid", "dismissed"] as const;

const datasetExpectedFindingSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive(),
  keywords: z.array(z.string().min(1)),
  selection: z
    .strictObject({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    })
    .optional(),
});

/**
 * One labeled evaluation case exported by `pipr runs export --dataset`. It is diagnostic data: it
 * holds the finding's path, body, and file contents at the reviewed base and head.
 */
export const findingDatasetCaseSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    id: z.string().min(1).max(200),
    description: z.string().min(1),
    label: z.enum(findingDatasetLabels),
    source: z.strictObject({
      findingId: findingIdSchema,
      executionId: z.string().regex(/^[a-f0-9]{32}$/),
      workId: token(200),
      baseSha: z.string().min(1),
      headSha: z.string().min(1),
      configHash: sha256.optional(),
      agent: agentName.optional(),
      model: modelName.optional(),
      facets: z.record(facetKey, facetValue),
    }),
    finding: z.strictObject({
      path: z.string().min(1),
      side: z.enum(["LEFT", "RIGHT"]),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      body: z.string(),
      suggestedFix: z.string().optional(),
    }),
    baseFiles: z.record(z.string().min(1), z.string()),
    headFiles: z.record(z.string().min(1), z.string()),
    deletedFiles: z.array(z.string().min(1)).optional(),
    expected: z.strictObject({
      findings: z.array(datasetExpectedFindingSchema),
      maxInlineFindings: z.number().int().nonnegative(),
    }),
    modes: z.array(z.literal("live")).min(1),
  })
  .superRefine((value, context) => {
    const positive = value.label !== "dismissed";
    if (positive !== value.expected.findings.length > 0) {
      context.addIssue({
        code: "custom",
        message: "positive labels expect the finding; dismissed expects none",
      });
    }
    if (!positive && value.expected.maxInlineFindings !== 0) {
      context.addIssue({ code: "custom", message: "dismissed cases allow no inline findings" });
    }
  });

export type FindingDatasetCase = z.infer<typeof findingDatasetCaseSchema>;
