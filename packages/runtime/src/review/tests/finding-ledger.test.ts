import { describe, expect, it } from "bun:test";
import { findingLedgerSchema, findingOutcomeEventSchema, type ReviewFinding } from "@usepipr/sdk";
import type { PriorReviewState } from "../../publication/types.js";
import { runtimeVersion } from "../../shared/version.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import { extractPriorReviewState } from "../comment-markers.js";
import {
  createFindingLedger,
  deriveReviewFindingOutcomes,
  type FindingAttribution,
  type FindingLedgerContext,
  findingOutcomeAnchors,
  verifierVerdictOutcome,
} from "../finding-ledger.js";
import { buildCommentPublishingPlan } from "../publication-plan.js";
import { validateReviewResult } from "../review.js";
import type { VerifierVerdict } from "../verifier.js";

const manifest = reviewTestManifest();
const security: FindingAttribution = {
  agent: "security-reviewer",
  model: "deepseek-v4-pro",
  facets: { severity: "high" },
};

function finding(body: string, line: number, rangeId = "range-1"): ReviewFinding {
  return { body, path: "src/a.ts", rangeId, side: "RIGHT", startLine: line, endLine: line };
}

function context(headSha: string): FindingLedgerContext {
  return { workId: `pipr-work-${headSha}`, baseSha: "base", headSha, configHash: "c".repeat(64) };
}

/** Runs validation, publication planning, outcome derivation, and publication like a review run. */
function reviewRun(options: {
  headSha: string;
  findings: ReviewFinding[];
  priorReviewState?: PriorReviewState;
  verdicts?: VerifierVerdict[];
  maxInlineComments?: number;
  executionId?: string;
  publish?: (findingIds: string[]) => string[];
  attribution?: FindingAttribution;
}) {
  const attribution = options.attribution ?? security;
  const validated = validateReviewResult(
    { summary: { body: "Review." }, inlineFindings: options.findings },
    manifest,
    {},
  );
  const publishing = buildCommentPublishingPlan({
    event: {
      change: {
        number: 1,
        title: "",
        description: "",
        base: { sha: "base" },
        head: { sha: options.headSha },
      },
    },
    main: "Review completed.",
    validated,
    manifest,
    maxInlineComments: options.maxInlineComments,
    priorReviewState: options.priorReviewState,
    findingOutcomes: (dispositions) =>
      deriveReviewFindingOutcomes({
        valid: validated.validFindings.map((item) => ({ finding: item, attribution })),
        dispositions,
        dropped: validated.droppedFindings.map((item) => ({
          finding: item.finding,
          code: item.code,
          attribution,
        })),
        priorReviewState: options.priorReviewState,
        verdicts: options.verdicts ?? [],
      }),
    metadata: {
      runtimeVersion,
      reviewedHeadSha: options.headSha,
      providerModels: ["deepseek-v4-pro"],
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: validated.validFindings.length,
      droppedFindings: validated.droppedFindings.length,
    },
  });
  const ledger = createFindingLedger({
    executionId: options.executionId ?? "0123456789abcdef0123456789abcdef",
  });
  ledger.record(context(options.headSha), publishing.findingOutcomes);
  const planned = publishing.inlineCommentDrafts.map((draft) => draft.findingId);
  ledger.recordPublished(context(options.headSha), options.publish?.(planned) ?? planned);
  const state = extractPriorReviewState(publishing.publicationPlan.mainComment, 1);
  return { ledger, publishing, state };
}

function committedState(state: PriorReviewState | undefined, headSha: string): PriorReviewState {
  if (!state) throw new Error("expected persisted review state");
  return {
    ...state,
    findings: state.findings.map((record) => ({ ...record, lastCommentedHeadSha: headSha })),
  };
}

describe("finding outcome ledger", () => {
  it("proposes, drops, and publishes findings with the IDs publication and the marker use", () => {
    const { ledger, publishing, state } = reviewRun({
      headSha: "head-1",
      findings: [
        finding("Unchecked input reaches the query.", 10),
        { ...finding("Phantom finding in a secret path.", 99), rangeId: "missing" },
      ],
    });

    const events = ledger.events();
    const publishedId = publishing.inlineCommentDrafts[0]?.findingId;
    expect(events.map((event) => [event.kind, event.reasonCode])).toEqual([
      ["proposed", undefined],
      ["proposed", undefined],
      ["dropped", "unknown-range"],
      ["published", undefined],
    ]);
    expect(events.find((event) => event.kind === "published")?.findingId).toBe(publishedId);
    expect(state?.findings.map((record) => record.id)).toEqual([publishedId]);
    const droppedId = events.find((event) => event.kind === "dropped")?.findingId;
    expect(droppedId).toMatch(/^fnd_[a-f0-9]{16}$/);
    expect(droppedId).not.toBe(publishedId);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(events[3]).toMatchObject({
      executionId: "0123456789abcdef0123456789abcdef",
      workId: "pipr-work-head-1",
      headSha: "head-1",
      configHash: "c".repeat(64),
      agent: "security-reviewer",
      model: "deepseek-v4-pro",
      facets: { severity: "high" },
    });
  });

  it("keeps public events content-free and diagnostic evidence keyed by finding ID", () => {
    const { ledger } = reviewRun({
      headSha: "head-1",
      findings: [
        finding("Unchecked input reaches the query.", 10),
        { ...finding("Phantom finding in a secret path.", 99), rangeId: "missing" },
      ],
    });

    const events = ledger.events();
    for (const event of events) expect(findingOutcomeEventSchema.parse(event)).toEqual(event);
    const publicJson = JSON.stringify(findingLedgerSchema.parse({ formatVersion: 1, events }));
    for (const content of ["src/a.ts", "Unchecked input", "Phantom", "missing", "rangeId"]) {
      expect(publicJson).not.toContain(content);
    }
    const document = ledger.document();
    const droppedId = events.find((event) => event.kind === "dropped")?.findingId ?? "";
    expect(document.evidence[droppedId]).toEqual({
      path: "src/a.ts",
      rangeId: "missing",
      side: "RIGHT",
      startLine: 99,
      endLine: 99,
      body: "Phantom finding in a secret path.",
      baseSha: "base",
      headSha: "head-1",
    });
  });

  it("derives stable event IDs across reruns of the same work", () => {
    const run = (executionId: string, headSha = "head-1") =>
      reviewRun({ headSha, executionId, findings: [finding("Unchecked input.", 10)] })
        .ledger.events()
        .map((event) => event.eventId);

    const first = run("0123456789abcdef0123456789abcdef");
    expect(run("fedcba9876543210fedcba9876543210")).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(run("0123456789abcdef0123456789abcdef", "head-2")).not.toContain(first[0]);
  });

  it("carries re-found findings, outdates missing ones, and records verifier verdicts", () => {
    const opened = reviewRun({
      headSha: "head-1",
      findings: [
        finding("Still reported.", 10),
        finding("No longer reported.", 11),
        finding("Fixed by the push.", 12),
        finding("Verifier says still valid.", 20, "range-2"),
      ],
    });
    const ids = opened.publishing.inlineCommentDrafts.map((draft) => draft.findingId);

    const synchronized = reviewRun({
      headSha: "head-2",
      findings: [finding("Still reported.", 10)],
      priorReviewState: committedState(opened.state, "head-1"),
      verdicts: [
        { findingId: ids[2] ?? "", status: "fixed" },
        { findingId: ids[3] ?? "", status: "still-valid" },
      ],
    });

    expect(
      synchronized.ledger
        .events()
        .map((event) => [event.kind, ids.indexOf(event.findingId)] as const),
    ).toEqual([
      ["proposed", 0],
      ["carried", 0],
      ["outdated", 1],
      ["fixed", 2],
      ["still-valid", 3],
      ["published", 0],
    ]);
  });

  it("drops capped findings and carries findings already commented at this head", () => {
    const opened = reviewRun({ headSha: "head-1", findings: [finding("First.", 10)] });
    const rerun = reviewRun({
      headSha: "head-1",
      findings: [finding("First.", 10), finding("Second.", 11)],
      priorReviewState: committedState(opened.state, "head-1"),
      maxInlineComments: 0,
    });

    expect(rerun.ledger.events().map((event) => [event.kind, event.reasonCode])).toEqual([
      ["proposed", undefined],
      ["proposed", undefined],
      ["carried", undefined],
      ["dropped", "inline-cap"],
    ]);
  });

  it("publishes only the findings a host actually posted", () => {
    const { ledger } = reviewRun({
      headSha: "head-1",
      findings: [finding("Posted.", 10), finding("Failed to post.", 11)],
      publish: (planned) => planned.slice(0, 1),
    });

    expect(ledger.events().filter((event) => event.kind === "published")).toHaveLength(1);
  });

  it("keeps each finding's outcome history, agent, model, and facets in review state", () => {
    const opened = reviewRun({
      headSha: "head-1",
      findings: [finding("Still reported.", 10), finding("No longer reported.", 11)],
    });
    const [kept, gone] = opened.state?.findings ?? [];
    expect(kept).toMatchObject({
      a: "security-reviewer",
      m: "deepseek-v4-pro",
      f: { severity: "high" },
      h: [["p", "head-1"]],
    });

    const synchronized = reviewRun({
      headSha: "head-2",
      findings: [finding("Still reported.", 10)],
      priorReviewState: committedState(opened.state, "head-1"),
    });
    const history = new Map(synchronized.state?.findings.map((record) => [record.id, record.h]));
    expect(history.get(kept?.id ?? "")).toEqual([
      ["p", "head-1"],
      ["c", "head-2"],
      ["p", "head-2"],
    ]);
    expect(history.get(gone?.id ?? "")).toEqual([
      ["p", "head-1"],
      ["o", "head-2"],
    ]);
  });

  it("attributes outcomes of findings not seen this run from the stored state", () => {
    const opened = reviewRun({
      headSha: "head-1",
      findings: [finding("Outdated.", 10), finding("Fixed.", 11)],
    });
    const fixedId = opened.publishing.inlineCommentDrafts[1]?.findingId ?? "";
    const synchronized = reviewRun({
      headSha: "head-2",
      findings: [],
      priorReviewState: committedState(opened.state, "head-1"),
      verdicts: [{ findingId: fixedId, status: "fixed" }],
    });

    const events = synchronized.ledger.events();
    expect(events.map((event) => event.kind)).toEqual(["outdated", "fixed"]);
    for (const { agent, model, facets } of events) {
      expect({ agent, model, facets }).toEqual({
        agent: security.agent,
        model: security.model,
        facets: security.facets,
      });
    }
  });

  it("gives verdicts and replies anchored to host markers one event across runs", () => {
    const findingId = "fnd_0123456789abcdef";
    const action = {
      kind: "resolve" as const,
      findingId,
      findingHeadSha: "head-1",
      commentId: "10",
      body: "Fixed.",
      responseKey: "head-2:fixed:fnd_0123456789abcdef",
    };
    const acted = createFindingLedger({ executionId: "0123456789abcdef0123456789abcdef" });
    acted.record(context("head-2"), [
      verifierVerdictOutcome({ findingId, status: "fixed", action }, undefined),
    ]);
    const rebuilt = createFindingLedger({ executionId: "fedcba9876543210fedcba9876543210" });
    rebuilt.record(context("head-3"), [
      { kind: "fixed", findingId, anchor: findingOutcomeAnchors.piprResolution("head-1") },
    ]);

    expect(rebuilt.events()[0]?.eventId).toBe(acted.events()[0]?.eventId);
  });

  it("emits schema-valid events and review state for unbounded attribution", () => {
    const unbounded: FindingAttribution = {
      agent: `Security\nreviewer ${"a".repeat(300)}`,
      model: "custom provider/model id",
      facets: { severity: "high\nurgent", "not a key": "x", area: "v".repeat(150) },
    };
    const opened = reviewRun({
      headSha: "head-1",
      findings: [finding("Unbounded attribution.", 10)],
      attribution: unbounded,
    });

    const events = opened.ledger.events();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(findingOutcomeEventSchema.safeParse(event).success).toBe(true);
      expect(event).toMatchObject({
        model: "custom-provider/model-id",
        facets: { severity: "high urgent", area: "v".repeat(100) },
      });
      expect(event.agent).toHaveLength(200);
    }
    expect(opened.state?.findings[0]).toMatchObject({
      a: events[0]?.agent,
      m: "custom-provider/model-id",
      f: { severity: "high urgent", area: "v".repeat(100) },
    });
  });

  it("normalizes attribution carried by stored review state", () => {
    const ledger = createFindingLedger({ executionId: "0123456789abcdef0123456789abcdef" });
    ledger.record(context("head-1"), [
      {
        kind: "outdated",
        findingId: "fnd_0123456789abcdef",
        attribution: { agent: "a\tb", model: "m o", facets: { k: "x\ny" } },
      },
    ]);

    expect(ledger.events()[0]).toMatchObject({ agent: "a b", model: "m-o", facets: { k: "x y" } });
  });

  it("records the host's thread resolution support in the ledger document", () => {
    const ledger = createFindingLedger({
      executionId: "0123456789abcdef0123456789abcdef",
      threadResolution: "unavailable",
    });

    expect(ledger.document()).toMatchObject({ threadResolution: "unavailable" });
    expect(
      createFindingLedger({ executionId: "0123456789abcdef0123456789abcdef" }).document(),
    ).not.toHaveProperty("threadResolution");
  });

  it("records replies with the actor permission and deduplicates repeated events", () => {
    const ledger = createFindingLedger({ executionId: "0123456789abcdef0123456789abcdef" });
    const reply = {
      kind: "replied" as const,
      findingId: "fnd_0123456789abcdef",
      actorPermission: "write" as const,
    };
    ledger.record(context("head-1"), [reply, reply]);

    expect(ledger.events()).toEqual([
      expect.objectContaining({ kind: "replied", actorPermission: "write", facets: {} }),
    ]);
  });
});
