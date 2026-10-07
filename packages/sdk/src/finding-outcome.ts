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
const token = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[\w.:/@+-]+$/, "must be a single token without whitespace");
const facetValue = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\n\r\t]+$/, "facet values must be single-line enum values");

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
    agent: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\n\r\t]+$/)
      .optional(),
    /** Model that produced the finding. */
    model: token(200).optional(),
    /** Declared enum field values of the finding. */
    facets: z
      .record(token(100), facetValue)
      .refine((facets) => Object.keys(facets).length <= 32, "at most 32 facets"),
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
      agent: z.string().min(1).max(200).optional(),
      model: token(200).optional(),
      facets: z.record(token(100), facetValue),
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
