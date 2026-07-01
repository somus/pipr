import type { ProviderConfig } from "../types.js";
import {
  type PiProviderInvocation,
  parsePiProviderInvocation,
  piReadOnlyToolNames,
} from "./contract.js";

export function toPiProviderInvocation(provider: ProviderConfig): PiProviderInvocation {
  return parsePiProviderInvocation({
    provider: provider.provider,
    model: provider.model,
    apiKeyEnv: provider.apiKeyEnv,
    thinking: provider.thinking ?? "high",
    tools: piReadOnlyToolNames,
  });
}
