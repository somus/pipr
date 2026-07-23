export type AgentRunBudget = {
  maxAgentRuns: number | undefined;
  reservedAgentRuns: number;
};

export class AgentRunBudgetExhaustedError extends Error {}

export function createAgentRunBudget(maxAgentRuns: number | undefined): AgentRunBudget {
  return { maxAgentRuns, reservedAgentRuns: 0 };
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
