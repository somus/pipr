export type AgentRunBudget = {
  maxAgentRuns: number | undefined;
  reservedAgentRuns: number;
  /** Calls seen per request identity in this run, so identical calls get distinct request ids. */
  requestOrdinals: Map<string, number>;
};

export class AgentRunBudgetExhaustedError extends Error {}

export function createAgentRunBudget(maxAgentRuns: number | undefined): AgentRunBudget {
  return { maxAgentRuns, reservedAgentRuns: 0, requestOrdinals: new Map() };
}

/** Fails before a batch starts when the remaining budget cannot cover one run per request. */
export function assertAgentRunCapacity(budget: AgentRunBudget | undefined, runs: number): void {
  if (budget?.maxAgentRuns === undefined) {
    return;
  }
  const remaining = budget.maxAgentRuns - budget.reservedAgentRuns;
  if (runs > remaining) {
    throw new AgentRunBudgetExhaustedError(
      `Review Run agent-call budget cannot start ${runs} concurrent runs; ${remaining} of ${budget.maxAgentRuns} remain`,
    );
  }
}

export function reserveAgentRun(budget: AgentRunBudget | undefined): void {
  if (!budget) {
    return;
  }
  if (budget.maxAgentRuns !== undefined && budget.reservedAgentRuns >= budget.maxAgentRuns) {
    throw new AgentRunBudgetExhaustedError(
      `Review Run agent-call budget exhausted after ${budget.reservedAgentRuns} provider invocations; limit=${budget.maxAgentRuns}`,
    );
  }
  budget.reservedAgentRuns += 1;
}
