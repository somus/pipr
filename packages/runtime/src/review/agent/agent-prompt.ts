import type { Agent, AgentTool, PathFilter, Schema } from "@usepipr/sdk";
import { renderPromptValue } from "@usepipr/sdk/internal";
import { compact } from "lodash-es";
import { piReadOnlyToolNames } from "../../pi/contract.js";
import type { PriorReviewState } from "../prior-state.js";
import { prReviewSchemaId, reviewSchemaExample } from "../review.js";
import type { PreparedDiffManifestContext } from "./diff-manifest-context.js";

export type AgentToolResolution = {
  customTools: AgentTool[];
};

export type PluginToolExecutionContext = {
  run: { id: string };
  repository: { root: string; name: string };
  change: {
    number: number;
    title: string;
    description: string;
    base: { sha: string };
    head: { sha: string };
  };
  platform: { id: string };
};

export type AgentRunContext = {
  prompt: {
    runId: string;
    repository: PluginToolExecutionContext["repository"];
    change: PluginToolExecutionContext["change"];
    platform: PluginToolExecutionContext["platform"];
  };
  tools: PluginToolExecutionContext;
};

export type PreparedAgentContext = {
  agentTools: AgentToolResolution;
  agentRunContext: AgentRunContext;
  diffManifest?: PreparedDiffManifestContext;
};

export async function renderAgentPrompt(
  options: {
    agent: Agent;
    input: unknown;
    runOptions?: {
      paths?: PathFilter;
      instructions?: unknown;
    };
    toolMode?: "read-only" | "none";
    runtime: {
      priorReviewState?: PriorReviewState;
    };
  } & PreparedAgentContext,
): Promise<string> {
  const prompt = await options.agent.definition.prompt(options.input as never, {
    ...options.agentRunContext.prompt,
  });
  const toolMode = options.toolMode ?? "read-only";
  return compact([
    promptSection("Role", "You are pipr's read-only change request agent."),
    promptSection("Tools", toolsPrompt(options.diffManifest, toolMode)),
    customToolPrompt(options.agentTools),
    pathScopePrompt(options.runOptions?.paths),
    promptSection("Output", outputPrompt(options.agent.definition.output)),
    promptSection("Diff Manifest", options.diffManifest?.body),
    promptSection("Instructions", renderPromptValue(options.agent.definition.instructions)),
    options.runOptions?.instructions
      ? promptSection("Run Instructions", renderPromptValue(options.runOptions.instructions))
      : undefined,
    priorFindingsPrompt(options.runtime.priorReviewState),
    promptSection("Prompt", renderPromptValue(prompt)),
  ]).join("\n\n");
}

function promptSection(title: string, body: string | undefined): string | undefined {
  if (!body?.trim()) {
    return undefined;
  }
  return `${title}:\n${body}`;
}

function toolsPrompt(
  diffManifest: PreparedDiffManifestContext | undefined,
  toolMode: "read-only" | "none",
): string {
  if (toolMode === "none") {
    return [
      "Available tools: none.",
      "Use only the prompt context. Do not request repository, filesystem, network, platform, or shell access.",
    ].join("\n");
  }
  const toolNames = [...piReadOnlyToolNames, ...(diffManifest?.runtimeToolNames ?? [])];
  return [
    `Available tools: ${toolNames.join(", ")}.`,
    "Use tools only to inspect repository content and pipr-provided review context.",
    "Do not write files, edit code, run shell commands, call platform APIs, or publish comments.",
  ].join("\n");
}

function outputPrompt(schema: Schema<unknown>): string {
  return compact([
    `Schema ID: ${schema.id}.`,
    schema.jsonSchema ? `JSON Schema:\n${JSON.stringify(schema.jsonSchema, null, 2)}` : undefined,
    schema.id === prReviewSchemaId
      ? `Example:\n${JSON.stringify(reviewSchemaExample(), null, 2)}`
      : undefined,
    schema.id === prReviewSchemaId
      ? "`suggestedFix` is exact replacement code for the selected range. Do not include Markdown fences, prose, or labels in `suggestedFix`."
      : undefined,
    "Return exactly one JSON value matching the schema.",
    "The first non-whitespace character must be { or [ and the last non-whitespace character must be } or ].",
    "Do not include Markdown, code fences, prose, explanations, or leading/trailing text.",
    schema.id === prReviewSchemaId
      ? "For inlineFindings, use only fields shown in the schema and only exact Diff Manifest commentable ranges. If no exact range applies, omit the finding."
      : undefined,
  ]).join("\n\n");
}

function pathScopePrompt(paths: PathFilter | undefined): string | undefined {
  if (!paths) {
    return undefined;
  }
  return [
    "Path scope:",
    "This run is scoped to repository paths matching this filter:",
    JSON.stringify(paths, null, 2),
    "Publishable inline findings must target only files matching this filter.",
    "Read tools may access the whole repository. Prefer matching files, and read non-matching files only when needed to understand or review matching files.",
  ].join("\n");
}

function priorFindingsPrompt(state: PriorReviewState | undefined): string | undefined {
  const openFindings = state?.findings.filter((finding) => finding.status === "open") ?? [];
  if (openFindings.length === 0) {
    return undefined;
  }
  return [
    "Prior pipr findings:",
    JSON.stringify(
      {
        reviewedHeadSha: state?.reviewedHeadSha,
        findings: openFindings.map((finding) => ({
          id: finding.id,
          path: finding.path,
          rangeId: finding.rangeId,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
        })),
      },
      null,
      2,
    ),
    "Re-check these findings against the current diff. If a prior finding still applies, emit one current inline finding for the same issue. If it no longer applies, omit it.",
  ].join("\n");
}

function customToolPrompt(agentTools: AgentToolResolution): string | undefined {
  if (agentTools.customTools.length === 0) {
    return undefined;
  }
  return [
    "Custom plugin tools:",
    ...agentTools.customTools.map(
      (tool) => `${tool.name}: ${tool.description ?? "No description."}`,
    ),
  ].join("\n");
}
