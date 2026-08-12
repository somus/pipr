import type { RuntimePlan, RuntimeTask } from "@usepipr/sdk/internal";
import { match, P } from "ts-pattern";
import {
  commandPatternPrefixMatches,
  isPiprCommandLine,
  parseCommandPattern,
} from "../commands/grammar.js";
import type { RepositoryPermission } from "../hosts/types.js";
import { selectRuntimeTasks } from "../review/task/select-runtime-tasks.js";
import type { CommandPermissionLevel } from "../types.js";

const permissionOrder: CommandPermissionLevel[] = ["read", "triage", "write", "maintain", "admin"];

type SelectedPlanCommand =
  | {
      kind: "matched";
      command: RuntimePlan["commands"][number];
      commandName: string;
      line: string;
      arguments: Record<string, string>;
    }
  | {
      kind: "invalid";
      command: RuntimePlan["commands"][number];
      error: string;
    };

export type PlanCommandResolution =
  | { kind: "ignored"; reason: string }
  | {
      kind: "help";
      reason: string;
      requiredPermission: CommandPermissionLevel;
      body: string;
    }
  | {
      kind: "invalid";
      reason: string;
      requiredPermission: CommandPermissionLevel;
      body: string;
    }
  | {
      kind: "matched";
      invocation: {
        taskName: string;
        commandName: string;
        requiredPermission: CommandPermissionLevel;
        line: string;
        pattern: string;
        arguments: Record<string, string>;
        inputs?: unknown;
      };
    };

export type RuntimeEntryDispatch =
  | {
      kind: "change-request";
      tasks: RuntimeTask[];
      taskName?: string;
    }
  | PlanCommandResolution;

export function dispatchRuntimeEntry(
  options:
    | { kind: "change-request"; plan: RuntimePlan; event: { action?: string }; taskName?: string }
    | { kind: "command"; plan: RuntimePlan; line: string | undefined },
): RuntimeEntryDispatch {
  return match(options)
    .with({ kind: "change-request" }, (options) => ({
      kind: "change-request" as const,
      tasks: selectRuntimeTasks({
        plan: options.plan,
        event: options.event,
        taskName: options.taskName,
      }),
      taskName: options.taskName,
    }))
    .with({ kind: "command" }, (options) => resolvePlanCommand(options.plan, options.line))
    .exhaustive();
}

function selectPlanCommand(plan: RuntimePlan, line: string): SelectedPlanCommand | undefined {
  let firstInvalid: SelectedPlanCommand | undefined;
  for (const command of plan.commands) {
    const parsed = parseCommandPattern(command.pattern, line);
    if (!parsed.ok) {
      if (commandPatternPrefixMatches(command.pattern, line) && !firstInvalid) {
        firstInvalid = { kind: "invalid", command, error: parsed.error };
      }
      continue;
    }
    return {
      kind: "matched",
      command,
      commandName: command.pattern.replace(/^@pipr\s+/, "").split(/\s+/)[0] ?? command.pattern,
      line,
      arguments: parsed.value,
    };
  }
  return firstInvalid;
}

export function resolvePlanCommand(
  plan: RuntimePlan,
  line: string | undefined,
): PlanCommandResolution {
  if (!line) {
    return { kind: "ignored", reason: "comment did not contain a command line" };
  }
  if (!isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "comment did not target pipr" };
  }
  return match(selectPlanCommand(plan, line))
    .with({ kind: "matched" }, (selected) => ({
      kind: "matched" as const,
      invocation: {
        taskName: selected.command.task.name,
        commandName: selected.commandName,
        requiredPermission: selected.command.permission,
        line: selected.line,
        pattern: selected.command.pattern,
        arguments: selected.arguments,
      },
    }))
    .with({ kind: "invalid" }, (selected) => ({
      kind: "invalid" as const,
      reason: selected.error,
      requiredPermission: selected.command.permission,
      body: renderPlanCommandHelp(plan, selected.error),
    }))
    .with(P.nullish, () => ({
      kind: "help" as const,
      reason: `unknown pipr command '${line}'`,
      requiredPermission: "read" as const,
      body: renderPlanCommandHelp(plan, `Unknown command: ${line}`),
    }))
    .exhaustive();
}

export function parsePlanCommandInputs(
  plan: RuntimePlan,
  invocation: Extract<PlanCommandResolution, { kind: "matched" }>["invocation"],
): PlanCommandResolution {
  const matchingCommand =
    plan.commands.find(
      (candidate) =>
        candidate.task.name === invocation.taskName && candidate.pattern === invocation.pattern,
    ) ?? plan.commands.find((candidate) => candidate.task.name === invocation.taskName);
  if (!matchingCommand) {
    return {
      kind: "invalid",
      reason: `No command registered for task '${invocation.taskName}'`,
      requiredPermission: invocation.requiredPermission,
      body: renderPlanCommandHelp(plan),
    };
  }
  try {
    return {
      kind: "matched",
      invocation: {
        ...invocation,
        inputs: matchingCommand.parse
          ? matchingCommand.parse(invocation.arguments)
          : invocation.arguments,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      reason,
      requiredPermission: invocation.requiredPermission,
      body: renderPlanCommandHelp(plan, reason),
    };
  }
}

export function hasRequiredRepositoryPermission(
  actual: RepositoryPermission,
  required: CommandPermissionLevel,
): boolean {
  if (actual === "none") {
    return false;
  }
  return permissionOrder.indexOf(actual) >= permissionOrder.indexOf(required);
}

export function permissionDeniedHelp(plan: RuntimePlan, required: CommandPermissionLevel): string {
  return renderPlanCommandHelp(plan, `Permission denied: requires ${required}.`);
}

function renderPlanCommandHelp(plan: RuntimePlan, reason?: string): string {
  const lines = ["# pipr commands", ""];
  if (reason) {
    lines.push(reason, "");
  }
  for (const command of plan.commands) {
    lines.push(`- ${command.pattern} (${command.permission})`);
  }
  return lines.join("\n");
}
