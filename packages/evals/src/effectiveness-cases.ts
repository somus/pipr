import type { PiprEvalCase } from "./cases.js";
import type { PiprEffectivenessVariant } from "./effectiveness.js";

const targetPath = "src/review-target.ts";

const recoveryBase = `export type Delivery = {
  status: "pending" | "processing" | "failed";
  attempts: number;
  payload: string | null;
  resultKind: string | null;
  resultJson: string | null;
};

export function startDelivery(row: Delivery): Delivery {
  return {
    ...row,
    status: "processing",
    attempts: row.attempts + 1,
    resultKind: null,
    resultJson: null,
  };
}
`;

const recoveryDefect = `${recoveryBase}
export function recoverInterrupted(row: Delivery): Delivery {
  if (row.status !== "processing") return row;
  const retryable = row.attempts < 3;
  return {
    ...row,
    status: retryable ? "pending" : "failed",
    payload: retryable ? row.payload : null,
  };
}
`;

const recoveryClean = `${recoveryBase}
export function recoverInterrupted(row: Delivery): Delivery {
  if (row.status !== "processing") return row;
  const retryable = row.attempts < 3;
  const interruptedResult = JSON.stringify({ kind: "error", message: "Delivery interrupted." });
  return {
    ...row,
    status: retryable ? "pending" : "failed",
    payload: retryable ? row.payload : null,
    resultKind: retryable ? null : "error",
    resultJson: retryable ? null : interruptedResult,
  };
}
`;

const orderingBase = `export type CommandState =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "superseded";

export type CommandStateRecord = {
  state: CommandState;
  reviewedHeadSha: string;
};

// Only accepted may replace a record for a different reviewed head. Every later
// lifecycle state belongs to the attempt identified by the existing head SHA.
`;

const orderingDefect = `${orderingBase}
export function shouldUpdateCommandComment(
  existing: CommandStateRecord | undefined,
  next: CommandStateRecord,
): boolean {
  if (next.state !== "failed" && next.state !== "superseded") return true;
  return existing === undefined || existing.reviewedHeadSha === next.reviewedHeadSha;
}
`;

const orderingClean = `${orderingBase}
export function shouldUpdateCommandComment(
  existing: CommandStateRecord | undefined,
  next: CommandStateRecord,
): boolean {
  if (next.state === "accepted") return true;
  return existing === undefined || existing.reviewedHeadSha === next.reviewedHeadSha;
}
`;

const dispatchBase = `export type CommandStatus = "accepted" | "running" | "failed" | "superseded";

export type CommandOptions = {
  reviewedHeadSha: string;
  publishStatus(status: CommandStatus): Promise<void>;
  prepareTrustedHead(): Promise<void>;
  currentHeadSha(): Promise<string>;
  runTask(): Promise<void>;
};
`;

const dispatchDefect = `${dispatchBase}
export async function dispatchCommand(options: CommandOptions): Promise<void> {
  await options.publishStatus("accepted");
  return await executeCommand(options);
}

async function executeCommand(options: CommandOptions): Promise<void> {
  try {
    await options.prepareTrustedHead();
    await options.publishStatus("running");
    await options.runTask();
  } catch (error) {
    const currentHeadSha = await options.currentHeadSha();
    await options.publishStatus(
      currentHeadSha === options.reviewedHeadSha ? "failed" : "superseded",
    );
    throw error;
  }
}
`;

const dispatchClean = `${dispatchBase}
export async function dispatchCommand(options: CommandOptions): Promise<void> {
  return await executeCommand(options);
}

async function executeCommand(options: CommandOptions): Promise<void> {
  try {
    await options.publishStatus("accepted");
    await options.prepareTrustedHead();
    await options.publishStatus("running");
    await options.runTask();
  } catch (error) {
    const currentHeadSha = await options.currentHeadSha();
    await options.publishStatus(
      currentHeadSha === options.reviewedHeadSha ? "failed" : "superseded",
    );
    throw error;
  }
}
`;

const emptyValueBase = `export function displayLabel(value: string | undefined): string {
  return value ?? "fallback";
}
`;

const emptyValueDefect = `export function displayLabel(value: string | undefined): string {
  return value || "fallback";
}
`;

const emptyValueClean = `export function displayLabel(value: string | undefined): string {
  return value === undefined ? "fallback" : value;
}
`;

const emptyValueContractTest = `import { displayLabel } from "./review-target";

test("preserves an intentionally empty label", () => {
  expect(displayLabel("")).toBe("");
});
`;

export const effectivenessBenchmarkCases: PiprEvalCase[] = [
  positiveCase({
    id: "pr105-interrupted-result-recovery",
    description: "Reports a final interrupted delivery that loses its structured failure result.",
    base: recoveryBase,
    head: recoveryDefect,
    expectedLine: lineOf(recoveryDefect, 'status: retryable ? "pending" : "failed"'),
    issueId: "interrupted-result-loss",
    keywordSets: [
      ["failed", "result"],
      ["terminal", "result"],
      ["failure", "structured"],
    ],
  }),
  cleanCase({
    id: "pr105-interrupted-result-recovery-clean",
    description: "Stays quiet when interrupted terminal deliveries retain a safe result.",
    base: recoveryBase,
    head: recoveryClean,
  }),
  positiveCase({
    id: "pr105-stale-lifecycle-overwrite",
    description: "Reports older running or completed states that can overwrite a newer attempt.",
    base: orderingBase,
    head: orderingDefect,
    expectedLine: lineOf(orderingDefect, 'next.state !== "failed"'),
    issueId: "stale-lifecycle-overwrite",
    keywordSets: [
      ["running", "newer"],
      ["completed", "newer"],
      ["non-terminal", "stale"],
      ["running", "out-of-order"],
      ["running", "different head", "overwrite"],
    ],
  }),
  cleanCase({
    id: "pr105-stale-lifecycle-overwrite-clean",
    description: "Stays quiet when every post-acceptance state is ordered by reviewed head.",
    base: orderingBase,
    head: orderingClean,
  }),
  positiveCase({
    id: "pr105-stale-acceptance-supersession",
    description: "Reports acceptance failures that bypass terminal supersession handling.",
    base: dispatchBase,
    head: dispatchDefect,
    expectedLine: lineOf(dispatchDefect, 'publishStatus("accepted")'),
    issueId: "acceptance-supersession-gap",
    keywordSets: [
      ["accepted", "superseded"],
      ["acceptance", "catch"],
      ["accepted", "error boundary"],
    ],
  }),
  cleanCase({
    id: "pr105-stale-acceptance-supersession-clean",
    description: "Stays quiet when acceptance failures pass through terminal status handling.",
    base: dispatchBase,
    head: dispatchClean,
  }),
  positiveCase({
    id: "empty-value-contract-regression",
    description: "Reports a falsy fallback that violates the explicit empty-string contract.",
    base: emptyValueBase,
    head: emptyValueDefect,
    supportFiles: { "src/review-target.test.ts": emptyValueContractTest },
    expectedLine: lineOf(emptyValueDefect, 'return value || "fallback"'),
    issueId: "empty-value-contract",
    keywordSets: [
      ["empty", "fallback"],
      ["falsy", "fallback"],
      ["empty", "||"],
    ],
  }),
  cleanCase({
    id: "empty-value-contract-regression-clean",
    description: "Stays quiet when an explicit fallback preserves the empty-string contract.",
    base: emptyValueBase,
    head: emptyValueClean,
    supportFiles: { "src/review-target.test.ts": emptyValueContractTest },
  }),
];

const genericInstructions = [
  "Review changed behavior for correctness, security, reliability, and meaningful test gaps.",
  "Return only actionable findings that target valid diff ranges.",
].join("\n");

export const effectivenessBenchmarkVariants: PiprEffectivenessVariant[] = [
  {
    id: "generic",
    reviewInstructions: genericInstructions,
  },
  {
    id: "failure-modes",
    reviewInstructions: [
      genericInstructions,
      "For stateful, asynchronous, persistence, or lifecycle changes, trace each transition, interruption point, stale or out-of-order write, and failure before or after the error boundary before deciding the change is safe.",
    ].join("\n"),
  },
];

function positiveCase(options: {
  id: string;
  description: string;
  base: string;
  head: string;
  supportFiles?: Record<string, string>;
  expectedLine: number;
  issueId: string;
  keywordSets: string[][];
}): PiprEvalCase {
  return {
    id: options.id,
    description: options.description,
    reviewer: "custom",
    modes: ["live"],
    baseFiles: { ...options.supportFiles, [targetPath]: options.base },
    headFiles: { ...options.supportFiles, [targetPath]: options.head },
    expected: {
      findings: [
        {
          line: options.expectedLine,
          path: targetPath,
          issueId: options.issueId,
          keywords: options.keywordSets[0] ?? [],
          keywordSets: options.keywordSets,
        },
      ],
      maxInlineFindings: 1,
      requirePiCall: true,
    },
  };
}

function cleanCase(options: {
  id: string;
  description: string;
  base: string;
  head: string;
  supportFiles?: Record<string, string>;
}): PiprEvalCase {
  return {
    id: options.id,
    description: options.description,
    reviewer: "custom",
    modes: ["live"],
    baseFiles: { ...options.supportFiles, [targetPath]: options.base },
    headFiles: { ...options.supportFiles, [targetPath]: options.head },
    expected: {
      findings: [],
      maxInlineFindings: 0,
      requirePiCall: true,
    },
  };
}

function lineOf(source: string, text: string): number {
  const index = source.split("\n").findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`effectiveness fixture line not found: ${text}`);
  return index + 1;
}
