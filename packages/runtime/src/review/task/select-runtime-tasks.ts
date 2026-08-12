import type { ChangeRequestAction } from "@usepipr/sdk";
import type { RuntimePlan, RuntimeTask } from "@usepipr/sdk/internal";
import { uniqBy } from "lodash-es";

const changeRequestActions = [
  "opened",
  "updated",
  "reopened",
  "ready",
  "closed",
] as const satisfies readonly ChangeRequestAction[];

export function selectRuntimeTasks(options: {
  plan: RuntimePlan;
  event: { action?: string };
  taskName?: string;
}): RuntimeTask[] {
  if (options.taskName) {
    return options.plan.tasks.filter((task) => task.name === options.taskName);
  }
  return selectChangeRequestTasks(options.plan, options.event);
}

export function selectLocalReviewTasks(plan: RuntimePlan): RuntimeTask[] {
  return uniqBy(
    plan.changeRequestTriggers.map((trigger) => trigger.task),
    (task) => task.name,
  ).filter((task) => task.local !== false);
}

function selectChangeRequestTasks(plan: RuntimePlan, event: { action?: string }): RuntimeTask[] {
  if (!changeRequestActions.includes(event.action as ChangeRequestAction)) {
    return [];
  }
  const action = event.action as ChangeRequestAction;
  return uniqBy(
    plan.changeRequestTriggers
      .filter((trigger) => trigger.actions.includes(action))
      .map((trigger) => trigger.task),
    (task) => task.name,
  );
}
