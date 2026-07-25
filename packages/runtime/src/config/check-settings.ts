import type { AggregateCheckOptions } from "@usepipr/sdk";
import type { RuntimeTask } from "@usepipr/sdk/internal";

export type NormalizedAggregateCheckSettings = {
  enabled: boolean;
  name?: string;
};

export type NormalizedTaskCheckSettings = {
  individual: boolean;
  aggregate: boolean;
  name: string;
  required: boolean;
};

export function aggregateCheckSettings(
  aggregate: AggregateCheckOptions | undefined,
): NormalizedAggregateCheckSettings {
  if (aggregate === undefined || aggregate === false || aggregate.enabled === false) {
    return { enabled: false };
  }
  return { enabled: true, name: aggregate.name ?? "all" };
}

export function taskCheckSettings(task: RuntimeTask): NormalizedTaskCheckSettings {
  const check = task.check;
  if (check === false) {
    return { individual: false, aggregate: false, name: task.name, required: false };
  }
  const options = typeof check === "object" ? check : undefined;
  return {
    individual: options !== undefined && options.enabled !== false,
    aggregate: true,
    name: options?.name ?? task.name,
    required: options?.required ?? true,
  };
}
