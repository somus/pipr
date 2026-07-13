import type { SecretRedactor } from "../shared/secret-redactor.js";
import type { ValidatedReview } from "../types.js";
import type { ThreadAction } from "./comment.js";
import type { RuntimeTaskCheckResult } from "./task/task-output.js";

export type RedactedReviewPublication = {
  main: string;
  validated: ValidatedReview;
  threadActions: ThreadAction[];
  taskChecks: RuntimeTaskCheckResult[];
};

export async function redactReviewPublication(options: {
  main: string;
  validated: ValidatedReview;
  threadActions: ThreadAction[];
  taskChecks: RuntimeTaskCheckResult[];
  redactor?: SecretRedactor;
}): Promise<RedactedReviewPublication> {
  if (!options.redactor) {
    return {
      main: options.main,
      validated: options.validated,
      threadActions: options.threadActions,
      taskChecks: options.taskChecks,
    };
  }

  const targets = [
    options.main,
    ...options.validated.validFindings.flatMap((finding) => [
      finding.body,
      ...(finding.suggestedFix ? [finding.suggestedFix] : []),
    ]),
    ...options.validated.droppedFindings.flatMap(({ finding }) => [
      finding.body,
      ...(finding.suggestedFix ? [finding.suggestedFix] : []),
    ]),
    ...(options.validated.review.summary.title ? [options.validated.review.summary.title] : []),
    options.validated.review.summary.body,
    ...options.validated.review.inlineFindings.flatMap((finding) => [
      finding.body,
      ...(finding.suggestedFix ? [finding.suggestedFix] : []),
    ]),
    ...options.threadActions.map((action) => action.body),
    ...options.taskChecks.flatMap((check) => (check.summary ? [check.summary] : [])),
  ];
  const redacted = await options.redactor.redact(targets);
  if (redacted.length !== targets.length) {
    throw new Error("Secret redactor returned an invalid result; publication aborted");
  }

  let index = 0;
  const main = redacted[index++]?.value;
  if (main === undefined) {
    throw new Error("Secret redactor omitted the main comment; publication aborted");
  }
  const redactFinding = (finding: ValidatedReview["validFindings"][number]) => {
    const body = redacted[index++];
    if (!body) {
      throw new Error("Secret redactor omitted an inline finding; publication aborted");
    }
    if (!finding.suggestedFix) {
      return { ...finding, body: body.value };
    }
    const suggestedFix = redacted[index++];
    if (!suggestedFix) {
      throw new Error("Secret redactor omitted a suggested fix; publication aborted");
    }
    if (suggestedFix.detected) {
      const next = { ...finding, body: body.value };
      delete next.suggestedFix;
      return next;
    }
    return { ...finding, body: body.value, suggestedFix: suggestedFix.value };
  };
  const validFindings = options.validated.validFindings.map(redactFinding);
  const droppedFindings = options.validated.droppedFindings.map((dropped) => ({
    ...dropped,
    finding: redactFinding(dropped.finding),
  }));
  const summaryTitle = options.validated.review.summary.title
    ? redacted[index++]?.value
    : undefined;
  if (options.validated.review.summary.title && summaryTitle === undefined) {
    throw new Error("Secret redactor omitted the review title; publication aborted");
  }
  const summaryBody = redacted[index++]?.value;
  if (summaryBody === undefined) {
    throw new Error("Secret redactor omitted the review summary; publication aborted");
  }
  const review = {
    ...options.validated.review,
    summary: {
      ...(summaryTitle ? { title: summaryTitle } : {}),
      body: summaryBody,
    },
    inlineFindings: options.validated.review.inlineFindings.map(redactFinding),
  };
  const threadActions = options.threadActions.map((action) => {
    const body = redacted[index++];
    if (!body) {
      throw new Error("Secret redactor omitted a verifier reply; publication aborted");
    }
    return { ...action, body: body.value };
  });
  const taskChecks = consumeTaskChecks(options.taskChecks, redacted, index);

  return {
    main,
    validated: { review, validFindings, droppedFindings },
    threadActions,
    taskChecks,
  };
}

export async function redactCommandPublication(options: {
  body: string;
  taskChecks: RuntimeTaskCheckResult[];
  redactor?: SecretRedactor;
}): Promise<{ body: string; taskChecks: RuntimeTaskCheckResult[] }> {
  if (!options.redactor) {
    return { body: options.body, taskChecks: options.taskChecks };
  }
  const targets = [
    options.body,
    ...options.taskChecks.flatMap((check) => (check.summary ? [check.summary] : [])),
  ];
  const redacted = await options.redactor.redact(targets);
  if (redacted.length !== targets.length || !redacted[0]) {
    throw new Error("Secret redactor returned an invalid result; publication aborted");
  }
  const taskChecks = consumeTaskChecks(options.taskChecks, redacted, 1);
  return {
    body: redacted[0].value,
    taskChecks,
  };
}

function consumeTaskChecks(
  checks: readonly RuntimeTaskCheckResult[],
  redacted: readonly { value: string }[],
  startIndex: number,
): RuntimeTaskCheckResult[] {
  let index = startIndex;
  return checks.map((check) => {
    if (!check.summary) {
      return check;
    }
    const summary = redacted[index++];
    if (!summary) {
      throw new Error("Secret redactor omitted a task check summary; publication aborted");
    }
    return { ...check, summary: summary.value };
  });
}

export async function redactThreadActions(options: {
  threadActions: ThreadAction[];
  redactor?: SecretRedactor;
}): Promise<ThreadAction[]> {
  if (!options.redactor || options.threadActions.length === 0) {
    return options.threadActions;
  }
  const redacted = await options.redactor.redact(
    options.threadActions.map((action) => action.body),
  );
  if (redacted.length !== options.threadActions.length) {
    throw new Error("Secret redactor returned an invalid result; publication aborted");
  }
  return options.threadActions.map((action, index) => {
    const body = redacted[index];
    if (!body) {
      throw new Error("Secret redactor omitted a verifier reply; publication aborted");
    }
    return { ...action, body: body.value };
  });
}
