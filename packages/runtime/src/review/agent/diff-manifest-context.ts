import {
  type DiffManifestPromptLimits,
  type DiffManifestPromptMode,
  type PreparedDiffManifestPrompt,
  prepareDiffManifestPrompt,
} from "../../diff/manifest-projection.js";
import type { DiffStructuralAnalysis } from "../../diff/structural-analysis.js";
import type { PiRuntimeReadToolName, PiRuntimeReadToolRequest } from "../../pi/runtime-tools.js";
import { piRuntimeReadToolNames, piRuntimeStructuralToolNames } from "../../pi/runtime-tools.js";
import type {
  DiffManifest,
  DiffManifestLimitsConfig,
  DiffManifestPromptMetrics,
} from "../../types.js";
import { parseDiffManifest } from "../../types.js";

export type PreparedDiffManifestContext = {
  manifest: DiffManifest;
  mode: DiffManifestPromptMode;
  metrics: {
    full: DiffManifestPromptMetrics;
    selected: DiffManifestPromptMetrics;
  };
  limits: DiffManifestPromptLimits;
  body: string;
  runtimeToolNames: readonly PiRuntimeReadToolName[];
  runtimeToolRequest?: PiRuntimeReadToolRequest;
};

export function prepareDiffManifestContext(options: {
  input: unknown;
  limits?: DiffManifestLimitsConfig;
  toolMode: "read-only" | "none";
  allowOversizedCondensed?: boolean;
  structuralAnalysis?: DiffStructuralAnalysis;
}): PreparedDiffManifestContext | undefined {
  const manifest = readReservedInputManifest(options.input);
  if (!manifest) {
    return undefined;
  }
  const prompt = prepareDiffManifestPrompt(manifest, options.limits, {
    allowOversizedCondensed: options.allowOversizedCondensed,
  });
  const runtimeToolsEnabled = options.toolMode !== "none" && prompt.mode === "condensed";
  const structuralAnalysis =
    options.structuralAnalysis?.available === true ? options.structuralAnalysis : undefined;
  const structuralToolsEnabled = runtimeToolsEnabled && structuralAnalysis !== undefined;
  const runtimeToolNames = runtimeToolsEnabled
    ? [...piRuntimeReadToolNames, ...(structuralToolsEnabled ? piRuntimeStructuralToolNames : [])]
    : [];
  return {
    manifest,
    mode: prompt.mode,
    metrics: prompt.metrics,
    limits: prompt.limits,
    body: diffManifestPromptBody(prompt, runtimeToolNames),
    runtimeToolNames,
    ...(runtimeToolsEnabled
      ? {
          runtimeToolRequest: {
            manifest,
            toolResponseMaxBytes: prompt.limits.toolResponseMaxBytes,
            ...(structuralToolsEnabled ? { structuralAnalysis } : {}),
          },
        }
      : {}),
  };
}

export function readReservedInputManifest(input: unknown): DiffManifest | undefined {
  if (typeof input !== "object" || input === null || !("manifest" in input)) {
    return undefined;
  }
  try {
    return parseDiffManifest((input as { manifest: unknown }).manifest);
  } catch {
    return undefined;
  }
}

function diffManifestPromptBody(
  prompt: PreparedDiffManifestPrompt,
  runtimeToolNames: readonly PiRuntimeReadToolName[],
): string {
  const toolNames = new Set(runtimeToolNames);
  return [
    "Use this as the authoritative changed-code context for this run.",
    "Each publishable inline finding's path, rangeId, and side must identify one Diff Manifest commentable range, and its startLine and endLine must select a valid span within that range.",
    "Do not invent publishable inline locations outside the Diff Manifest.",
    "",
    "Payload:",
    JSON.stringify(
      {
        mode: prompt.mode,
        metrics: prompt.metrics,
        limits: prompt.limits,
      },
      null,
      2,
    ),
    "",
    "Manifest:",
    JSON.stringify(prompt.manifest, null, 2),
    ...(runtimeToolNames.length > 0
      ? [
          "",
          "Condensed manifest helper tools:",
          ...(toolNames.has("pipr_read_diff")
            ? ["pipr_read_diff returns bounded full Diff Manifest slices."]
            : []),
          ...(toolNames.has("pipr_read_at_ref")
            ? ["pipr_read_at_ref reads bounded base or head file content."]
            : []),
          ...(toolNames.has("pipr_read_declaration")
            ? [
                "pipr_read_declaration retrieves bounded enclosing declaration context for a manifest range.",
              ]
            : []),
          ...(toolNames.has("pipr_ast_grep")
            ? [
                "pipr_ast_grep verifies syntax-specific patterns across explicit safe repository paths.",
              ]
            : []),
          "Start from the manifest and keep tool queries narrow. Treat tool output as evidence rather than authority, and omit findings when evidence remains insufficient.",
        ]
      : []),
  ].join("\n");
}
