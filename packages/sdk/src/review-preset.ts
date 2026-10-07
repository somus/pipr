import { z } from "zod";
import { facetsForFindingSchema } from "./finding.js";
import { md } from "./markdown.js";
import { isPromptText } from "./prompt-render.js";
import type { ReviewFinding, ReviewSummary } from "./review-contract.js";
import type { Agent } from "./types/agent.js";
import type { ModelProfile } from "./types/config.js";
import type { Schema } from "./types/schema.js";
import type {
  ChangeRequestContext,
  ChangeRequestInfo,
  CommentValue,
  PiprBuilder,
  ReviewFindingsInput,
  ReviewOptions,
  ReviewRenderInput,
  ReviewSummaryInput,
  Task,
  TaskContext,
} from "./types/task.js";
import { defaultReviewTriggers } from "./types/task.js";

const reviewOptionKeys = new Set([
  "id",
  "on",
  "model",
  "fallbacks",
  "tools",
  "timeout",
  "check",
  "paths",
  "finding",
  "instructions",
  "summary",
  "gate",
  "render",
]);

/** Registers the `pipr.review` preset task. */
export function registerReviewPreset<Finding extends ReviewFinding, Summary>(
  api: PiprBuilder,
  options: ReviewOptions<Finding, Summary>,
  defaultModel: ModelProfile | undefined,
): Task {
  assertReviewOptions(options);
  const model = options.model ?? defaultModel;
  if (!model) {
    throw new Error("pipr.review requires a model; register one with pipr.model first.");
  }
  const finding = options.finding ?? (api.finding({}) as unknown as z.ZodType<Finding>);
  const facets = facetsForFindingSchema(finding) ?? {};
  const findingsAgent = api.agent<ReviewFindingsInput, { inlineFindings: Finding[] }>({
    name: `${options.id}-findings`,
    model,
    fallbacks: options.fallbacks,
    instructions: options.instructions,
    tools: options.tools ?? api.tools.readOnly,
    output: options.finding
      ? z.strictObject({ inlineFindings: z.array(finding) })
      : (api.schemas.inlineFindings as unknown as Schema<{ inlineFindings: Finding[] }>),
    timeout: options.timeout,
    prompt: () => api.prompt`Review this change for actionable inline findings.`,
  });
  const summaryAgent = createSummaryAgent(api, options, model);

  return api.task({
    name: options.id,
    on: options.on ?? defaultReviewTriggers,
    check: options.check,
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true, paths: options.paths });
      if (options.paths && diff.manifest.files.length === 0) {
        ctx.check.neutral("No changed files matched this review's path scope.");
        await ctx.comment({ main: "No changed files matched this review's path scope." });
        return;
      }
      const runOptions = { timeout: options.timeout, paths: options.paths };
      const change = changeInfo(ctx.change);
      const result = await ctx.pi.run(findingsAgent, { diff, change }, runOptions);
      const selected = ctx.review.select(result.inlineFindings, {
        finding,
        paths: options.paths,
      });
      const findings = selected.findings as unknown as readonly Finding[];
      const summary = summaryAgent
        ? await ctx.pi.run(summaryAgent, { diff: diff.summary(), change, findings }, runOptions)
        : undefined;
      if (options.gate) {
        ctx.check.gate(findings, options.gate);
      }
      const renderInput: ReviewRenderInput<Finding, Summary> = {
        findings,
        dropped: selected.dropped as unknown as ReviewRenderInput<Finding, Summary>["dropped"],
        ...(summary === undefined ? {} : { summary }),
      };
      await ctx.comment(
        options.render
          ? await options.render(renderInput, reviewCommentContext(ctx, options.id))
          : defaultReviewComment(renderInput, Object.keys(facets)),
      );
    },
  });
}

function createSummaryAgent<Finding extends ReviewFinding, Summary>(
  api: PiprBuilder,
  options: ReviewOptions<Finding, Summary>,
  model: ModelProfile,
): Agent<ReviewSummaryInput<Finding>, Summary> | undefined {
  if (!options.summary) {
    return undefined;
  }
  if (options.summary.agent) {
    return options.summary.agent;
  }
  return api.agent<ReviewSummaryInput<Finding>, ReviewSummary>({
    name: `${options.id}-summary`,
    model,
    fallbacks: options.fallbacks,
    instructions: options.summary.instructions,
    tools: options.tools ?? api.tools.readOnly,
    output: api.schemas.summary,
    timeout: options.timeout,
    prompt: ({ diff, findings }) =>
      api.prompt`
        Summarize this change using the selected inline findings as evidence.

        ${api.section("Changed files", api.json(diff, { maxCharacters: 60_000 }))}

        ${api.section("Selected inline findings", api.json(findings, { maxCharacters: 60_000 }))}
      `,
  }) as unknown as Agent<ReviewSummaryInput<Finding>, Summary>;
}

function defaultReviewComment<Finding extends ReviewFinding, Summary>(
  result: ReviewRenderInput<Finding, Summary>,
  facetKeys: readonly string[],
): CommentValue {
  const summary = summaryText(result.summary);
  const inlineFindings = result.findings.map((finding) => ({
    ...finding,
    body: String(inlineBody(finding, facetKeys)),
  }));
  const findingList =
    result.findings.length === 0
      ? md`No inline findings.`
      : md.list(result.findings.map((finding) => inlineHeadline(finding, facetKeys)));
  return {
    main: md.blocks(
      summary
        ? md.blocks(md`## Summary`, summary.title ? md`**${summary.title}**` : "", summary.body)
        : "",
      md`## Findings`,
      findingList,
    ),
    inlineFindings,
  };
}

function inlineHeadline(finding: ReviewFinding, facetKeys: readonly string[]) {
  const labels = facetLabels(finding, facetKeys);
  const firstLine = finding.body.split(/\r?\n/, 1)[0] ?? finding.body;
  return labels ? md`**${labels}:** ${md.line(firstLine)}` : md.line(firstLine);
}

function inlineBody(finding: ReviewFinding, facetKeys: readonly string[]) {
  const labels = facetLabels(finding, facetKeys);
  return labels ? md`**${labels}:** ${finding.body}` : md`${finding.body}`;
}

function facetLabels(finding: ReviewFinding, facetKeys: readonly string[]): string {
  const record = finding as Record<string, unknown>;
  return facetKeys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string")
    .map((value) => String(md.label(value)))
    .join(" · ");
}

function summaryText(summary: unknown): { title?: string; body: string } | undefined {
  if (typeof summary !== "object" || summary === null) {
    return undefined;
  }
  const body = Reflect.get(summary, "body");
  const title = Reflect.get(summary, "title");
  return typeof body === "string"
    ? { body, ...(typeof title === "string" ? { title } : {}) }
    : undefined;
}

function changeInfo(change: ChangeRequestContext): ChangeRequestInfo {
  return {
    number: change.number,
    title: change.title,
    description: change.description,
    url: change.url,
    author: change.author,
    base: change.base,
    head: change.head,
    isFork: change.isFork,
  };
}

function reviewCommentContext(ctx: TaskContext, id: string) {
  return {
    review: { id },
    run: ctx.run,
    repository: ctx.repository,
    change: ctx.change,
    platform: ctx.platform,
  };
}

function assertReviewOptions<Finding extends ReviewFinding, Summary>(
  options: ReviewOptions<Finding, Summary>,
): void {
  const unknownKeys = Object.keys(options).filter((key) => !reviewOptionKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`pipr.review received unsupported option fields: ${unknownKeys.join(", ")}.`);
  }
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw new Error("pipr.review requires an id.");
  }
  if (!isPromptSource(options.instructions)) {
    throw new Error("pipr.review requires instructions for the findings agent.");
  }
  const summary = options.summary as { agent?: unknown; instructions?: unknown } | undefined;
  if (summary !== undefined && !summary.agent && !isPromptSource(summary.instructions)) {
    throw new Error("pipr.review summary requires instructions or an agent.");
  }
}

function isPromptSource(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : isPromptText(value);
}
