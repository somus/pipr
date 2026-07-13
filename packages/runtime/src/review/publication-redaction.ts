import type { SecretRedactionResult, SecretRedactor } from "../shared/secret-redactor.js";
import type { ValidatedReview } from "../types.js";
import type { ThreadAction } from "./comment.js";
import type { RuntimeTaskCheckResult } from "./task/task-output.js";

export type RedactedReviewPublication = {
  main: string;
  validated: ValidatedReview;
  threadActions: ThreadAction[];
  taskChecks: RuntimeTaskCheckResult[];
};

type RedactionTarget = {
  value: string;
  apply(result: SecretRedactionResult): void;
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

  const publication: RedactedReviewPublication = {
    main: options.main,
    validated: {
      review: {
        ...options.validated.review,
        summary: { ...options.validated.review.summary },
        inlineFindings: options.validated.review.inlineFindings.map((finding) => ({
          ...finding,
        })),
      },
      validFindings: options.validated.validFindings.map((finding) => ({ ...finding })),
      droppedFindings: options.validated.droppedFindings.map((dropped) => ({
        ...dropped,
        finding: { ...dropped.finding },
      })),
    },
    threadActions: options.threadActions.map((action) => ({ ...action })),
    taskChecks: options.taskChecks.map((check) => ({ ...check })),
  };
  const targets: RedactionTarget[] = [
    {
      value: publication.main,
      apply: (result) => {
        publication.main = result.value;
      },
    },
  ];
  const addFindingTargets = (finding: ValidatedReview["validFindings"][number]) => {
    targets.push({
      value: finding.body,
      apply: (result) => {
        finding.body = result.value;
      },
    });
    if (finding.suggestedFix) {
      targets.push({
        value: finding.suggestedFix,
        apply: (result) => {
          if (result.detected) {
            delete finding.suggestedFix;
          } else {
            finding.suggestedFix = result.value;
          }
        },
      });
    }
  };
  publication.validated.validFindings.forEach(addFindingTargets);
  publication.validated.droppedFindings.forEach(({ finding }) => {
    addFindingTargets(finding);
  });
  const { summary } = publication.validated.review;
  if (summary.title) {
    targets.push({
      value: summary.title,
      apply: (result) => {
        summary.title = result.value;
      },
    });
  }
  targets.push({
    value: summary.body,
    apply: (result) => {
      summary.body = result.value;
    },
  });
  publication.validated.review.inlineFindings.forEach(addFindingTargets);
  publication.threadActions.forEach((action) => {
    targets.push({
      value: action.body,
      apply: (result) => {
        action.body = result.value;
      },
    });
  });
  publication.taskChecks.forEach((check) => {
    if (check.summary) {
      targets.push({
        value: check.summary,
        apply: (result) => {
          check.summary = result.value;
        },
      });
    }
  });

  const redacted = await options.redactor.redact(targets.map((target) => target.value));
  if (redacted.length !== targets.length) {
    throw new Error("Secret redactor returned an invalid result; publication aborted");
  }
  redacted.forEach((result, index) => {
    // biome-ignore lint/style/noNonNullAssertion: equal lengths are validated above.
    targets[index]!.apply(result);
  });

  return publication;
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
  if (redacted.length !== targets.length) {
    throw new Error("Secret redactor returned an invalid result; publication aborted");
  }
  const taskChecks = consumeTaskChecks(options.taskChecks, redacted, 1);
  return {
    // biome-ignore lint/style/noNonNullAssertion: targets always contains the body.
    body: redacted[0]!.value,
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
