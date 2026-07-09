import type { Agent, AgentPromptContext, AgentTool, PathFilter, Schema } from "@usepipr/sdk";
import { renderPromptValue } from "@usepipr/sdk/internal";
import { compact } from "lodash-es";
import { piReadOnlyToolNames } from "../../pi/contract.js";
import { maxInlineFindingBodyCharacters } from "../inline-finding-limits.js";
import type { PriorReviewState } from "../prior-state.js";
import { reviewResultSchemaId, reviewSchemaExample } from "../review.js";
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
  const prompt = await renderAgentDefinitionPrompt(
    options.agent,
    options.input,
    options.agentRunContext.prompt,
  );
  const toolMode = options.toolMode ?? "read-only";
  return compact([
    promptSection("Role", "You are pipr's read-only change request agent."),
    promptSection("Tools", toolsPrompt(options.diffManifest, toolMode)),
    customToolPrompt(options.agentTools),
    pathScopePrompt(options.runOptions?.paths),
    reviewPolicyPrompt(options.agent.definition.output),
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

function renderAgentDefinitionPrompt<Input>(
  agent: Agent<Input, unknown>,
  input: unknown,
  context: AgentPromptContext,
) {
  // Runtime input was selected by the user task that called ctx.pi.run for this agent.
  return agent.definition.prompt(input as Input, { ...context });
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
  const suggestedFixRules = suggestedFixOutputPromptLines();
  const lines: string[] = compact([
    `Schema ID: ${schema.id}.`,
    schema.jsonSchema ? `JSON Schema:\n${JSON.stringify(schema.jsonSchema, null, 2)}` : undefined,
    "Return exactly one JSON value matching the schema.",
    "The first non-whitespace character must be { or [ and the last non-whitespace character must be } or ].",
    "Do not include Markdown, code fences, prose, explanations, or leading/trailing text.",
  ]);
  if (schema.id === reviewResultSchemaId) {
    lines.splice(
      2,
      0,
      `Example:\n${JSON.stringify(reviewSchemaExample(), null, 2)}`,
      ...suggestedFixRules,
    );
    lines.push(
      "For inlineFindings, use only fields shown in the schema and only exact Diff Manifest commentable ranges. If no exact range applies, omit the finding.",
      `For inlineFindings.body, write the exact inline comment body. Use one short paragraph, at most two sentences, and at most ${maxInlineFindingBodyCharacters} characters. Treat ${maxInlineFindingBodyCharacters} as a hard ceiling, not a target; prefer 250-450 characters when possible.`,
    );
  } else if (schemaMentionsField(schema.jsonSchema, "suggestedFix")) {
    lines.splice(2, 0, ...suggestedFixRules);
  }
  return lines.join("\n\n");
}

function suggestedFixOutputPromptLines(): string[] {
  return [
    "`suggestedFix` is exact replacement code for the selected range. Do not include Markdown fences, prose, or labels in `suggestedFix`.",
    "GitHub applies `suggestedFix` to the selected `startLine` through `endLine`. Select the smallest contiguous line span that the replacement code should replace.",
    "If a fix changes only part of a line, select that whole line and put the full replacement line in `suggestedFix`. If a fix changes multiple lines, select exactly those original lines and put the full replacement block in `suggestedFix`.",
    "Do not select a larger enclosing block to replace a smaller statement, and do not select one line when the replacement is for a multi-line section. Omit `suggestedFix` if the exact replacement range is uncertain.",
    "If you include `suggestedFix`, the finding body must describe the defect that `suggestedFix` directly fixes. Omit `suggestedFix` when the exact code change would not address the issue stated in the body.",
    "Do not include `suggestedFix` when it would be identical to the selected lines, only remove a trailing blank line, or only change whitespace.",
    "Omit `suggestedFix` for secrets, credentials, API keys, tokens, or config wiring unless the replacement uses an existing secret, environment variable, or config key already present in the surrounding code.",
    "Omit `suggestedFix` for broad rewrites, generated docs/pages, uncertain ranges, or changes better described in prose.",
  ];
}

function schemaMentionsField(value: unknown, fieldName: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => schemaMentionsField(item, fieldName));
  }
  return Object.entries(value).some(
    ([key, child]) => key === fieldName || schemaMentionsField(child, fieldName),
  );
}

function reviewPolicyPrompt(schema: Schema<unknown>): string | undefined {
  if (schema.id !== reviewResultSchemaId) {
    return undefined;
  }
  return promptSection(
    "Review Policy",
    [
      "Review only changed behavior.",
      "Report only actionable defects, security risks, regressions, or meaningful test gaps.",
      "Put each actionable issue in inlineFindings. Do not leave actionable defects or test gaps only in the summary.",
      "Inline finding bodies are final code-review comments, not analysis notes.",
      `State the concrete defect and user-visible or runtime impact directly. Keep each body to one short paragraph, at most two sentences, and at most ${maxInlineFindingBodyCharacters} characters.`,
      "Do not include step-by-step reasoning, broad context, praise, restated diff, alternatives, or code snippets unless they are necessary to identify the defect.",
      "Omit speculative, style-only, broad refactor, external-fact, and out-of-diff findings.",
      "Use read tools when more context is needed. If evidence is insufficient, omit the finding.",
      "Emit one inline finding per issue, anchored to the exact Diff Manifest commentable range.",
      "`suggestedFix` must be exact replacement code for the selected range.",
      "For `suggestedFix`, choose the smallest contiguous `startLine` to `endLine` span that should be replaced. Do not select an enclosing function, block, or single line unless that exact span is the replacement target.",
      "If you include `suggestedFix`, the finding body must describe the defect that `suggestedFix` directly fixes. Omit `suggestedFix` when the exact code change would not address the issue stated in the body.",
      "Do not include `suggestedFix` when it would be identical to the selected lines, only remove a trailing blank line, or only change whitespace.",
      "Omit `suggestedFix` for secrets, credentials, API keys, tokens, or config wiring unless the replacement uses an existing secret, environment variable, or config key already present in the surrounding code.",
      "Omit `suggestedFix` for broad rewrites, generated docs/pages, uncertain ranges, or changes better described in prose.",
    ].join("\n"),
  );
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
