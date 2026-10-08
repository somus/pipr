import type { AttemptRecord } from "./event-observation.js";
import type { RunAgentUsage, RunObserver } from "./types.js";

/** A finished agent attempt as the recorder saw it. */
export type RecordedAttempt = {
  /** Sequence and attempt type, such as `001-initial`; also the attempt's artifact name suffix. */
  id: string;
  /** How the attempt began, without its prompt. */
  options: Omit<Parameters<RunObserver["beginAgentAttempt"]>[0], "prompt">;
  status: "ok" | "error";
  usage?: RunAgentUsage;
  record: AttemptRecord;
};

export type RecordedTask = { name: string; order: number; status?: "ok" | "error" };

const emptyUsage = (): RunAgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

/** Content-free token and cost totals per run, per response model, and per attempt. */
export function usageDocument(attempts: readonly RecordedAttempt[]): unknown {
  const totals = emptyUsage();
  const byModel: Record<string, RunAgentUsage & { turns: number }> = {};
  for (const attempt of attempts) {
    if (attempt.usage) addUsage(totals, attempt.usage);
    for (const [model, usage] of attempt.record.models) {
      const total = byModel[model] ?? { ...emptyUsage(), turns: 0 };
      addUsage(total, usage);
      total.turns += usage.turns;
      byModel[model] = total;
    }
  }
  return {
    formatVersion: 1,
    totals,
    byModel,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.id,
      agent: attempt.options.agent,
      ...(attempt.options.task === undefined ? {} : { task: attempt.options.task }),
      provider: attempt.options.provider,
      model: attempt.options.model,
      responseModels: [...attempt.record.models.keys()],
      turns: attempt.record.turns,
      status: attempt.status,
      ...(attempt.usage ? { usage: attempt.usage } : {}),
    })),
  };
}

type TaskNode = { name: string | null; task?: RecordedTask; agents: Map<string, unknown[]> };

/** Tasks, the agents they ran, and each attempt's conversation, so a reader can follow forks and repairs. */
export function taskGraphDocument(
  tasks: readonly RecordedTask[],
  attempts: readonly RecordedAttempt[],
): unknown {
  const nodes: TaskNode[] = [...tasks]
    .sort((left, right) => left.order - right.order)
    .map((task) => ({ name: task.name, task, agents: new Map() }));
  for (const attempt of attempts) {
    const name = attempt.options.task ?? null;
    let node = nodes.find((candidate) => candidate.name === name);
    if (!node) {
      node = { name, agents: new Map() };
      nodes.push(node);
    }
    const list = node.agents.get(attempt.options.agent) ?? [];
    node.agents.set(attempt.options.agent, list);
    list.push(attemptNode(attempt));
  }
  return {
    formatVersion: 1,
    tasks: nodes.map((node) => ({
      name: node.name,
      ...(node.task ? { order: node.task.order } : {}),
      ...(node.task?.status ? { status: node.task.status } : {}),
      agents: [...node.agents].map(([agent, list]) => ({ name: agent, attempts: list })),
    })),
  };
}

function attemptNode(attempt: RecordedAttempt): Record<string, unknown> {
  const conversationId = attempt.record.conversation?.conversationId;
  return {
    attempt: attempt.id,
    attemptType: attempt.options.attemptType,
    provider: attempt.options.provider,
    model: attempt.options.model,
    status: attempt.status,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(attempt.options.conversation ? { conversation: attempt.options.conversation } : {}),
    ...(attempt.options.shardIndex === undefined ? {} : { shardIndex: attempt.options.shardIndex }),
    ...(attempt.options.shardCount === undefined ? {} : { shardCount: attempt.options.shardCount }),
  };
}

function addUsage(total: RunAgentUsage, usage: RunAgentUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.costUsd += usage.costUsd;
}
