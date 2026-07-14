import {
  builtinReadOnlyToolBrand,
  type ConfigFactoryValue,
  configFactoryBrand,
  type InternalPiprConfigFactory,
} from "./internal-contract.js";
import type { AgentTool } from "./types/agent.js";

export type { RuntimePlan } from "./runtime-contract.js";
export { defaultMaxStoredFindings, maxStoredFindingsLimit } from "./types/config.js";

import type { RuntimePlan } from "./runtime-contract.js";

export {
  assertSupportedCommandRestCapture,
  commandPatternParts,
  isCommandCaptureToken,
  isCommandRestCaptureToken,
  isOptionalCommandPatternPart,
  tokenizeCommandPattern,
  unsupportedCommandRestCaptureError,
} from "./command-grammar.js";
export { renderPromptValue } from "./prompt-render.js";
export type { SdkDeclarationModule } from "./standalone-declaration.js";
export {
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
} from "./standalone-declaration.js";

/** Stable identifier for pipr's built-in pull request review output schema. */
export const reviewOutputSchemaId = "core/pr-review";

/** Returns whether a tool is one of pipr's built-in read-only tools. */
export function isBuiltinReadOnlyTool(tool: AgentTool): boolean {
  return Reflect.get(tool, builtinReadOnlyToolBrand) === true;
}

/** Checks that an unknown value is a pipr configuration factory. */
export function isPiprConfigFactory(value: unknown): value is ConfigFactoryValue {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "pipr.config-factory" &&
    Reflect.get(value, configFactoryBrand) === true
  );
}

/** Builds a runtime plan from a pipr configuration factory. */
export function buildPiprPlan(factory: unknown): RuntimePlan {
  if (!isInternalPiprConfigFactory(factory)) {
    throw new Error("Expected a pipr configuration factory");
  }
  return factory.build();
}

function isInternalPiprConfigFactory(value: unknown): value is InternalPiprConfigFactory {
  return isPiprConfigFactory(value) && typeof Reflect.get(value, "build") === "function";
}
