import {
  type DiffManifestPromptLimits,
  type DiffManifestPromptMode,
  type PreparedDiffManifestPrompt,
  prepareDiffManifestPrompt,
} from "../../diff/manifest-projection.js";
import type { PiRuntimeReadToolName, PiRuntimeReadToolRequest } from "../../pi/runtime-tools.js";
import { piRuntimeReadToolNames } from "../../pi/runtime-tools.js";
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
}): PreparedDiffManifestContext | undefined {
  const manifest = readReservedInputManifest(options.input);
  if (!manifest) {
    return undefined;
  }
  const prompt = prepareDiffManifestPrompt(manifest, options.limits);
  const runtimeToolsEnabled = options.toolMode !== "none" && prompt.mode === "condensed";
  return {
    manifest,
    mode: prompt.mode,
    metrics: prompt.metrics,
    limits: prompt.limits,
    body: diffManifestPromptBody(prompt, runtimeToolsEnabled),
    runtimeToolNames: runtimeToolsEnabled ? piRuntimeReadToolNames : [],
    ...(runtimeToolsEnabled
      ? {
          runtimeToolRequest: {
            manifest,
            toolResponseMaxBytes: prompt.limits.toolResponseMaxBytes,
          },
        }
      : {}),
  };
}

function readReservedInputManifest(input: unknown): DiffManifest | undefined {
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
  includeRuntimeTools: boolean,
): string {
  return [
    "Use this as the authoritative changed-code context for this run.",
    "If your output includes publishable inline findings, each finding's path, rangeId, side, startLine, and endLine must come from a Diff Manifest commentable range.",
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
    ...(includeRuntimeTools
      ? [
          "",
          "Condensed manifest helper tools:",
          "pipr_read_diff(path?, rangeId?) returns bounded full Diff Manifest slices.",
          "pipr_read_at_ref(path, ref, rangeId?) reads bounded base or head file content.",
          "Use these tools only when the condensed manifest lacks enough detail.",
        ]
      : []),
  ].join("\n");
}
