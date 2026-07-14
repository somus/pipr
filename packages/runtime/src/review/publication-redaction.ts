import type { SecretRedactor } from "../shared/secret-redaction.js";
import type { ValidatedReview } from "../types.js";
import type { ThreadAction } from "./comment.js";
import type { RuntimeTaskCheckResult } from "./task/task-output.js";

export type RedactedReviewPublication = {
  main: string;
  validated: ValidatedReview;
  threadActions: ThreadAction[];
  taskChecks: RuntimeTaskCheckResult[];
};

export function redactReviewPublication(options: {
  main: string;
  validated: ValidatedReview;
  threadActions: ThreadAction[];
  taskChecks: RuntimeTaskCheckResult[];
  redactor?: SecretRedactor;
}): RedactedReviewPublication {
  if (!options.redactor) {
    return {
      main: options.main,
      validated: options.validated,
      threadActions: options.threadActions,
      taskChecks: options.taskChecks,
    };
  }

  const redactor = options.redactor;
  const review = options.validated.review;
  return {
    main: redactor.redact(options.main).value,
    validated: {
      review: {
        ...review,
        summary: {
          ...(review.summary.title ? { title: redactor.redact(review.summary.title).value } : {}),
          body: redactor.redact(review.summary.body).value,
        },
        inlineFindings: review.inlineFindings.map((finding) => redactFinding(finding, redactor)),
      },
      validFindings: options.validated.validFindings.map((finding) =>
        redactFinding(finding, redactor),
      ),
      droppedFindings: options.validated.droppedFindings.map((dropped) => ({
        ...dropped,
        finding: redactFinding(dropped.finding, redactor),
      })),
    },
    threadActions: redactThreadActions({
      threadActions: options.threadActions,
      redactor,
    }),
    taskChecks: redactTaskChecks(options.taskChecks, redactor),
  };
}

export function redactCommandPublication(options: {
  body: string;
  taskChecks: RuntimeTaskCheckResult[];
  redactor?: SecretRedactor;
}): { body: string; taskChecks: RuntimeTaskCheckResult[] } {
  if (!options.redactor) {
    return { body: options.body, taskChecks: options.taskChecks };
  }
  return {
    body: options.redactor.redact(options.body).value,
    taskChecks: redactTaskChecks(options.taskChecks, options.redactor),
  };
}

export function redactThreadActions(options: {
  threadActions: ThreadAction[];
  redactor?: SecretRedactor;
}): ThreadAction[] {
  if (!options.redactor) {
    return options.threadActions;
  }
  const redactor = options.redactor;
  return options.threadActions.map((action) => ({
    ...action,
    body: redactor.redact(action.body).value,
  }));
}

function redactFinding(
  finding: ValidatedReview["validFindings"][number],
  redactor: SecretRedactor,
): ValidatedReview["validFindings"][number] {
  const body = redactor.redact(finding.body).value;
  if (!finding.suggestedFix) {
    return { ...finding, body };
  }
  const suggestedFix = redactor.redact(finding.suggestedFix);
  if (suggestedFix.detected) {
    const redacted = { ...finding, body };
    delete redacted.suggestedFix;
    return redacted;
  }
  return { ...finding, body, suggestedFix: suggestedFix.value };
}

function redactTaskChecks(
  checks: readonly RuntimeTaskCheckResult[],
  redactor: SecretRedactor,
): RuntimeTaskCheckResult[] {
  return checks.map((check) =>
    check.summary ? { ...check, summary: redactor.redact(check.summary).value } : check,
  );
}
