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

// Pending and processing rows have no result. Terminal failures clear the
// retryable payload and store a safe structured error for downstream readers.

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

const recoveryContractTest = `import { expect, test } from "bun:test";
import { recoverInterrupted } from "./review-target";

test("stores a safe result when an interrupted delivery exhausts retries", () => {
  const recovered = recoverInterrupted({
    status: "processing",
    attempts: 3,
    payload: "sensitive input",
    resultKind: null,
    resultJson: null,
  });

  expect(recovered.status).toBe("failed");
  expect(recovered.payload).toBeNull();
  expect(recovered.resultKind).toBe("error");
  expect(JSON.parse(recovered.resultJson ?? "null")).toEqual({
    kind: "error",
    message: "Delivery interrupted.",
  });
});

test("preserves a retryable interrupted delivery", () => {
  const recovered = recoverInterrupted({
    status: "processing",
    attempts: 2,
    payload: "retry input",
    resultKind: null,
    resultJson: null,
  });

  expect(recovered).toEqual({
    status: "pending",
    attempts: 2,
    payload: "retry input",
    resultKind: null,
    resultJson: null,
  });
});

test("leaves a non-processing delivery unchanged", () => {
  const row = {
    status: "pending" as const,
    attempts: 1,
    payload: "queued input",
    resultKind: null,
    resultJson: null,
  };

  expect(recoverInterrupted(row)).toEqual(row);
});
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

// Any state may create the first record, but only accepted may replace a record
// for a different reviewed head. Later states must match the existing head SHA.
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

const orderingContractTest = `import { expect, test } from "bun:test";
import { shouldUpdateCommandComment } from "./review-target";

test("orders lifecycle updates by reviewed head", () => {
  const existing = { state: "accepted" as const, reviewedHeadSha: "head-2" };

  expect(
    shouldUpdateCommandComment(existing, { state: "running", reviewedHeadSha: "head-1" }),
  ).toBe(false);
  expect(
    shouldUpdateCommandComment(existing, { state: "completed", reviewedHeadSha: "head-2" }),
  ).toBe(true);
  expect(
    shouldUpdateCommandComment(existing, { state: "accepted", reviewedHeadSha: "head-3" }),
  ).toBe(true);
  expect(
    shouldUpdateCommandComment(undefined, { state: "running", reviewedHeadSha: "head-1" }),
  ).toBe(true);
});

test("orders later states for an existing running record", () => {
  const existing = { state: "running" as const, reviewedHeadSha: "head-2" };

  expect(
    shouldUpdateCommandComment(existing, { state: "completed", reviewedHeadSha: "head-2" }),
  ).toBe(true);
  expect(
    shouldUpdateCommandComment(existing, { state: "completed", reviewedHeadSha: "head-1" }),
  ).toBe(false);
  expect(
    shouldUpdateCommandComment(existing, { state: "failed", reviewedHeadSha: "head-2" }),
  ).toBe(true);
  expect(
    shouldUpdateCommandComment(existing, { state: "superseded", reviewedHeadSha: "head-1" }),
  ).toBe(false);
});
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

const dispatchTerminalReporting = `async function reportTerminalStatus(
  options: CommandOptions,
): Promise<void> {
  try {
    const currentHeadSha = await options.currentHeadSha();
    await options.publishStatus(
      currentHeadSha === options.reviewedHeadSha ? "failed" : "superseded",
    );
  } catch {
    // Best-effort terminal reporting must not replace the task error.
  }
}
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
    await reportTerminalStatus(options);
    throw error;
  }
}

${dispatchTerminalReporting}
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
    await reportTerminalStatus(options);
    throw error;
  }
}

${dispatchTerminalReporting}
`;

const dispatchContractTest = `import { expect, test } from "bun:test";
import {
  dispatchCommand,
  type CommandOptions,
  type CommandStatus,
} from "./review-target";

type FailureStage = "accepted" | "prepare" | "running" | "task";

function commandScenario(options: {
  failureStage?: FailureStage;
  currentHeadSha?: string;
  currentHeadFailure?: boolean;
  terminalStatusFailure?: boolean;
} = {}): { command: CommandOptions; statuses: CommandStatus[] } {
  const statuses: CommandStatus[] = [];
  const fail = (stage: FailureStage): void => {
    if (options.failureStage === stage) throw new Error(stage + " failed");
  };
  return {
    statuses,
    command: {
      reviewedHeadSha: "head-1",
      publishStatus: async (status) => {
        statuses.push(status);
        if (status === "accepted") fail("accepted");
        if (status === "running") fail("running");
        if (options.terminalStatusFailure && (status === "failed" || status === "superseded")) {
          throw new Error("terminal reporting failed");
        }
      },
      prepareTrustedHead: async () => fail("prepare"),
      currentHeadSha: async () => {
        if (options.currentHeadFailure) throw new Error("current head failed");
        return options.currentHeadSha ?? "head-1";
      },
      runTask: async () => fail("task"),
    },
  };
}

test("reports a terminal state when accepted publication fails", async () => {
  const { command, statuses } = commandScenario({ failureStage: "accepted" });

  await expect(dispatchCommand(command)).rejects.toThrow("accepted failed");
  expect(statuses).toEqual(["accepted", "failed"]);
});

test("reports failures from every command stage", async () => {
  const expectations: Array<{ stage: FailureStage; statuses: CommandStatus[] }> = [
    { stage: "prepare", statuses: ["accepted", "failed"] },
    { stage: "running", statuses: ["accepted", "running", "failed"] },
    { stage: "task", statuses: ["accepted", "running", "failed"] },
  ];

  for (const expectation of expectations) {
    const { command, statuses } = commandScenario({ failureStage: expectation.stage });
    await expect(dispatchCommand(command)).rejects.toThrow(expectation.stage + " failed");
    expect(statuses).toEqual(expectation.statuses);
  }
});

test("reports superseded when the reviewed head changed", async () => {
  const { command, statuses } = commandScenario({
    failureStage: "task",
    currentHeadSha: "head-2",
  });

  await expect(dispatchCommand(command)).rejects.toThrow("task failed");
  expect(statuses).toEqual(["accepted", "running", "superseded"]);
});

test("preserves the command error when terminal reporting fails", async () => {
  const { command, statuses } = commandScenario({
    failureStage: "task",
    terminalStatusFailure: true,
  });

  await expect(dispatchCommand(command)).rejects.toThrow("task failed");
  expect(statuses).toEqual(["accepted", "running", "failed"]);
});

test("resolves after every command stage succeeds", async () => {
  const { command, statuses } = commandScenario();

  await expect(dispatchCommand(command)).resolves.toBeUndefined();
  expect(statuses).toEqual(["accepted", "running"]);
});

test("preserves the command error when current-head lookup fails", async () => {
  const { command, statuses } = commandScenario({
    failureStage: "task",
    currentHeadFailure: true,
  });

  await expect(dispatchCommand(command)).rejects.toThrow("task failed");
  expect(statuses).toEqual(["accepted", "running"]);
});
`;

const emptyValueBase = `// Callers pass string or undefined; null is rejected at the input boundary.
export function displayLabel(value: string | undefined): string {
  return value ?? "fallback";
}
`;

const emptyValueDefect = `// Callers pass string or undefined; null is rejected at the input boundary.
export function displayLabel(value: string | undefined): string {
  return value || "fallback";
}
`;

const emptyValueClean = `// Callers pass string or undefined; null is rejected at the input boundary.
export function displayLabel(value: string | undefined): string {
  return value === undefined ? "fallback" : value;
}
`;

const emptyValueContractTest = `import { expect, test } from "bun:test";
import { displayLabel } from "./review-target";

test("preserves an intentionally empty label", () => {
  expect(displayLabel("")).toBe("");
});

test("uses the fallback for an absent label", () => {
  expect(displayLabel(undefined)).toBe("fallback");
});
`;

export const effectivenessBenchmarkCases: PiprEvalCase[] = [
  positiveCase({
    id: "pr105-interrupted-result-recovery",
    description: "Reports a final interrupted delivery that loses its structured failure result.",
    base: recoveryBase,
    head: recoveryDefect,
    headSupportFiles: { "src/review-target.test.ts": recoveryContractTest },
    expectedLine: lineOf(recoveryDefect, 'status: retryable ? "pending" : "failed"'),
    acceptableLines: [
      lineOf(recoveryDefect, 'status: retryable ? "pending" : "failed"'),
      lineOf(recoveryDefect, "payload: retryable ? row.payload : null"),
    ],
    issueId: "interrupted-result-loss",
    keywordSets: [
      ["failed", "result"],
      ["terminal", "result"],
      ["failure", "structured"],
      ["resultkind", "structured error"],
    ],
  }),
  cleanCase({
    id: "pr105-interrupted-result-recovery-clean",
    description: "Stays quiet when interrupted terminal deliveries retain a safe result.",
    base: recoveryBase,
    head: recoveryClean,
    headSupportFiles: { "src/review-target.test.ts": recoveryContractTest },
  }),
  positiveCase({
    id: "pr105-stale-lifecycle-overwrite",
    description: "Reports older running or completed states that can overwrite a newer attempt.",
    base: orderingBase,
    head: orderingDefect,
    headSupportFiles: { "src/review-target.test.ts": orderingContractTest },
    expectedLine: lineOf(orderingDefect, 'next.state !== "failed"'),
    acceptableLines: [
      lineOf(orderingDefect, "): boolean {"),
      lineOf(orderingDefect, 'next.state !== "failed"'),
      lineOf(orderingDefect, "return existing === undefined"),
    ],
    issueId: "stale-lifecycle-overwrite",
    keywordSets: [
      ["running", "newer"],
      ["completed", "newer"],
      ["non-terminal", "stale"],
      ["running", "out-of-order"],
      ["running", "different head", "overwrite"],
      ["running", "head", "overwrit"],
      ["running", "attempt", "replac"],
      ["running", "head", "replac"],
      ["running", "head", "bypass"],
    ],
  }),
  cleanCase({
    id: "pr105-stale-lifecycle-overwrite-clean",
    description: "Stays quiet when every post-acceptance state is ordered by reviewed head.",
    base: orderingBase,
    head: orderingClean,
    headSupportFiles: { "src/review-target.test.ts": orderingContractTest },
  }),
  positiveCase({
    id: "pr105-stale-acceptance-supersession",
    description: "Reports acceptance failures that bypass terminal supersession handling.",
    base: dispatchBase,
    head: dispatchDefect,
    headSupportFiles: { "src/review-target.test.ts": dispatchContractTest },
    expectedLine: lineOf(dispatchDefect, 'publishStatus("accepted")'),
    issueId: "acceptance-supersession-gap",
    keywordSets: [
      ["accepted", "superseded"],
      ["acceptance", "catch"],
      ["accepted", "error boundary"],
      ["accepted", "terminal status"],
      ["accepted", "reportterminalstatus"],
    ],
  }),
  cleanCase({
    id: "pr105-stale-acceptance-supersession-clean",
    description: "Stays quiet when acceptance failures pass through terminal status handling.",
    base: dispatchBase,
    head: dispatchClean,
    headSupportFiles: { "src/review-target.test.ts": dispatchContractTest },
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
  headSupportFiles?: Record<string, string>;
  expectedLine: number;
  acceptableLines?: number[];
  issueId: string;
  keywordSets: string[][];
}): PiprEvalCase {
  const files = effectivenessCaseFiles(options);
  return {
    id: options.id,
    description: options.description,
    reviewer: "custom",
    modes: ["live"],
    ...files,
    expected: {
      findings: [
        {
          line: options.expectedLine,
          acceptableLines: options.acceptableLines,
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
  headSupportFiles?: Record<string, string>;
}): PiprEvalCase {
  const files = effectivenessCaseFiles(options);
  return {
    id: options.id,
    description: options.description,
    reviewer: "custom",
    modes: ["live"],
    ...files,
    expected: {
      findings: [],
      maxInlineFindings: 0,
      requirePiCall: true,
    },
  };
}

function effectivenessCaseFiles(options: {
  base: string;
  head: string;
  supportFiles?: Record<string, string>;
  headSupportFiles?: Record<string, string>;
}): Pick<PiprEvalCase, "baseFiles" | "headFiles"> {
  return {
    baseFiles: { ...options.supportFiles, [targetPath]: options.base },
    headFiles: { ...options.supportFiles, ...options.headSupportFiles, [targetPath]: options.head },
  };
}

function lineOf(source: string, text: string): number {
  const index = source.split("\n").findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`effectiveness fixture line not found: ${text}`);
  return index + 1;
}
