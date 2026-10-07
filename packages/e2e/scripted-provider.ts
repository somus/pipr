// Scripted model provider for Action fixtures: answers from the rendered prompt and drives the Pipr read tools.
import { appendFile, chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type Provider,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

export type ActProviderConfig = {
  /** Directory that receives one JSONL telemetry file per model call. */
  callsDir?: string;
  /** Fails every primary-model call so the fixture exercises fallback. */
  failPrimaryProvider?: boolean;
  /** Returns invalid JSON for the first condensed answer so the fixture exercises repair. */
  invalidFirstOutput?: boolean;
  /** Asserts the worker runs as UID/GID 1000 over a read-only workspace. */
  expectSandboxIdentity?: boolean;
};

type PromptKind = "full" | "condensed" | "orchestrator" | "correctness" | "security" | "tests";

const fixturePath = "packages/e2e/fixtures/act/project/sample.ts";
const primaryModel = "deepseek-v4-pro";
const repairPromptPrefix = "Your previous answer failed schema validation.";
const condensedToolNames = [
  "read",
  "grep",
  "find",
  "ls",
  "pipr_read_diff",
  "pipr_read_at_ref",
  "pipr_read_declaration",
  "pipr_ast_grep",
];

type Range = {
  id: string;
  path: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  kind?: string;
  preview?: string;
  [key: string]: unknown;
};
type Manifest = { files: Array<{ path: string; commentableRanges: Range[] }> };
type ModelCall = { kind: PromptKind; prompt: string; latest: string; messages: readonly Message[] };

export default async function actProviders(configPath: unknown): Promise<Provider> {
  const config = (
    typeof configPath === "string" ? await Bun.file(configPath).json() : {}
  ) as ActProviderConfig;
  if (config.expectSandboxIdentity) {
    await assertSandboxIdentity();
  }
  const faux = fauxProvider({
    provider: "deepseek",
    models: [{ id: primaryModel }, { id: "deepseek-v4-fallback" }],
  });
  faux.setResponses(
    Array.from({ length: 1000 }, () => async (context, _options, _state, model) => {
      try {
        return await respond(config, modelCall(context.messages), model.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
      }
    }),
  );
  return faux.provider;
}

async function respond(
  config: ActProviderConfig,
  call: ModelCall,
  modelId: string,
): Promise<AssistantMessage> {
  const failPrimary = config.failPrimaryProvider && modelId === primaryModel;
  if (!config.callsDir) {
    return answers[call.kind](config, call, failPrimary);
  }
  const end = await recordCallStart(config.callsDir, call, modelId);
  try {
    // Holding each call open lets the full fixture prove that parallel agent runs overlap.
    await Bun.sleep(400);
    return answers[call.kind](config, call, failPrimary);
  } finally {
    await end();
  }
}

const specialist = (call: ModelCall) =>
  json({ focus: call.kind, summary: `${capitalize(call.kind)} specialist review` });

const answers: Record<
  PromptKind,
  (config: ActProviderConfig, call: ModelCall, failPrimary: boolean | undefined) => AssistantMessage
> = {
  orchestrator: (_config, call) => json(orchestratorReview(call.prompt)),
  correctness: (_config, call) => specialist(call),
  security: (_config, call) => specialist(call),
  tests: (_config, call) => specialist(call),
  condensed: (config, call, failPrimary) => {
    assert(!failPrimary, "scripted primary provider fixture failure");
    return condensedAnswer(config, call);
  },
  full: (_config, call) => json(fullFixtureReview(call.prompt)),
};

function modelCall(messages: readonly Message[]): ModelCall {
  const userTexts = messages.flatMap((message) =>
    message.role === "user" ? [textOf(message.content)] : [],
  );
  const prompt = userTexts.join("\n\n");
  const latest = userTexts.at(-1) ?? "";
  return { kind: promptKind(prompt, latest), prompt, latest, messages };
}

/** Checked in order; the first marker found in the prompt (or, for specialists, the latest turn) names the call. */
const promptKindMarkers: Array<[PromptKind, (prompt: string, latest: string) => boolean]> = [
  ["orchestrator", (prompt) => prompt.includes("Specialist reviews:")],
  ["correctness", (_prompt, latest) => latest.includes("Focus: correctness")],
  ["security", (_prompt, latest) => latest.includes("Focus: security")],
  ["tests", (_prompt, latest) => latest.includes("Focus: tests")],
  ["condensed", (prompt) => prompt.includes('"mode": "condensed"')],
];

function promptKind(prompt: string, latest: string): PromptKind {
  return promptKindMarkers.find(([, matches]) => matches(prompt, latest))?.[0] ?? "full";
}

function fullFixtureReview(prompt: string) {
  assertPathScopePrompt(prompt);
  const range = fullFixtureRange(parsePromptJson<Manifest>(prompt, "\nManifest:"));
  const finding = {
    path: range.path,
    rangeId: range.id,
    side: range.side,
    startLine: range.startLine,
    endLine: range.startLine,
  };
  return {
    summary: {
      title: "Fixture review",
      body: "Scripted provider reviewed the act full-flow fixture.",
    },
    inlineFindings: [
      {
        body: "Full-flow act reached inline publication.",
        ...finding,
        suggestedFix: "const normalized = true;",
      },
      ...(prompt.includes("Path scope:")
        ? [
            {
              body: "Out-of-scope act path should not publish.",
              ...finding,
              path: "docs/out-of-scope.md",
            },
          ]
        : []),
    ],
  };
}

/** Picks the RIGHT range that adds `normalized`; the fixture diff always contains it. */
function fullFixtureRange(manifest: Manifest): Range {
  const ranges = manifest.files.flatMap((file) => file.commentableRanges);
  const range = ranges.find(
    (item) =>
      item.path === fixturePath && item.side === "RIGHT" && item.preview?.includes("normalized"),
  );
  assert(range, "full manifest missing the RIGHT range that adds normalized");
  return range;
}

function assertPathScopePrompt(prompt: string): void {
  if (!prompt.includes("Path scope:")) {
    return;
  }
  assert(
    prompt.includes('"packages/e2e/fixtures/act/project/**"'),
    "path-scoped prompt missing include glob",
  );
  assert(prompt.includes('"**/*.test.ts"'), "path-scoped prompt missing exclude glob");
  assert(
    prompt.includes("Read tools may access the whole repository."),
    "path-scoped prompt did not preserve whole-repo read access",
  );
}

function orchestratorReview(prompt: string) {
  for (const focus of ["Correctness", "Security", "Tests"]) {
    assert(prompt.includes(`${focus} specialist review`), `orchestrator prompt missing ${focus}`);
  }
  const range = fixtureRanges(
    parsePromptJson<Manifest>(prompt, "\nManifest:"),
    "orchestrator",
  ).right;
  return {
    summary: {
      title: "Orchestrator fixture review",
      body: "Orchestrated review combined correctness, security, and tests specialist outputs.",
    },
    findings: [
      {
        body: "Orchestrator custom schema mapped a labeled finding into core inline output.",
        path: range.path,
        rangeId: range.id,
        side: range.side,
        startLine: range.startLine,
        endLine: range.startLine,
        severity: "medium",
      },
    ],
  };
}

/**
 * The first condensed turn calls every Pipr read tool, the next turn checks the tool results, and the answer after
 * that is the review. With `invalidFirstOutput`, the first review is invalid JSON so the runtime sends a repair turn.
 */
function condensedAnswer(config: ActProviderConfig, call: ModelCall): AssistantMessage {
  const manifest = parsePromptJson<Manifest>(call.prompt, "\nManifest:");
  const results = toolResultsSinceLatestUser(call.messages);
  if (call.latest.startsWith(repairPromptPrefix)) {
    return json(condensedReview());
  }
  if (results.length === 0) {
    assertCondensedPrompt(call, manifest);
    return fauxAssistantMessage(
      condensedChecks(manifest).map((check) =>
        fauxToolCall(check.name, check.args, { id: check.id }),
      ),
      { stopReason: "toolUse" },
    );
  }
  assertCondensedToolResults(condensedChecks(manifest), results);
  return config.invalidFirstOutput ? fauxAssistantMessage("{invalid") : json(condensedReview());
}

function condensedReview() {
  return review(
    "Condensed fixture review",
    "Condensed act fixture reached Pi after runtime tools passed.",
  );
}

function assertCondensedPrompt(call: ModelCall, manifest: Manifest): void {
  const tools = offeredToolNames(call.messages);
  assert(
    tools.join(",") === condensedToolNames.join(","),
    `unexpected condensed tool allowlist: ${tools.join(",")}`,
  );
  const payload = parsePromptJson<{ mode?: string }>(call.prompt, "\nPayload:");
  assert(payload.mode === "condensed", "expected condensed manifest payload");
  for (const description of [
    "pipr_read_diff returns",
    "pipr_read_at_ref reads",
    "pipr_read_declaration retrieves",
    "pipr_ast_grep verifies",
  ]) {
    assert(call.prompt.includes(description), `prompt did not describe ${description}`);
  }
  const { right } = fixtureRanges(manifest, "condensed");
  assert(!("preview" in right), "condensed range kept preview");
  for (const key of ["id", "path", "side", "startLine", "endLine", "kind", "hunkHeader"]) {
    assert(right[key] !== undefined, `condensed range missing ${key}`);
  }
}

type ToolCheck = {
  id: string;
  name: string;
  args: Record<string, string | string[]>;
  /** Substring the tool result text must contain; error checks also require `isError`. */
  expect: string;
  error?: boolean;
};

function condensedChecks(manifest: Manifest): ToolCheck[] {
  const { file, right, left } = fixtureRanges(manifest, "condensed");
  const rangeRead = (ref: string, rangeId: string) => ({ path: file.path, ref, rangeId });
  return [
    { id: "diff-path", name: "pipr_read_diff", args: { path: file.path }, expect: "normalized" },
    { id: "diff-range", name: "pipr_read_diff", args: { rangeId: right.id }, expect: right.id },
    {
      id: "head",
      name: "pipr_read_at_ref",
      args: rangeRead("head", right.id),
      expect: "normalized",
    },
    {
      id: "base",
      name: "pipr_read_at_ref",
      args: rangeRead("base", left.id),
      expect: "legacy.trim()",
    },
    {
      id: "base-opposite-side",
      name: "pipr_read_at_ref",
      args: rangeRead("base", right.id),
      expect: '"available":false',
    },
    {
      id: "declaration-head",
      name: "pipr_read_declaration",
      args: rangeRead("head", right.id),
      expect: '"qualifiedName":"reviewTarget"',
    },
    {
      id: "declaration-base",
      name: "pipr_read_declaration",
      args: rangeRead("base", left.id),
      expect: "legacy.trim()",
    },
    {
      id: "ast-grep",
      name: "pipr_ast_grep",
      args: {
        pattern: "function $NAME($$$ARGS): $RET { $$$BODY }",
        language: "ts",
        paths: [file.path],
      },
      expect: file.path,
    },
    {
      id: "ast-grep-none",
      name: "pipr_ast_grep",
      args: { pattern: "class $NAME { $$$BODY }", language: "ts", paths: [file.path] },
      expect: '"matches":[]',
    },
    {
      id: "diff-missing-path",
      name: "pipr_read_diff",
      args: { path: "packages/e2e/fixtures/act/project/missing.ts" },
      expect: "not in the Diff Manifest",
      error: true,
    },
    {
      id: "diff-missing-range",
      name: "pipr_read_diff",
      args: { rangeId: "rng_missing" },
      expect: "Unknown Diff Manifest range",
      error: true,
    },
    {
      id: "unsafe-path",
      name: "pipr_read_at_ref",
      args: { path: "../sample.ts", ref: "head", rangeId: right.id },
      expect: "Unsafe manifest path",
      error: true,
    },
    {
      id: "unsupported-ref",
      name: "pipr_read_at_ref",
      args: rangeRead("topic", right.id),
      expect: 'Validation failed for tool "pipr_read_at_ref"',
      error: true,
    },
  ];
}

function assertCondensedToolResults(checks: ToolCheck[], results: ToolResultMessage[]): void {
  for (const check of checks) {
    const result = results.find((item) => item.toolCallId === check.id);
    assert(result, `${check.name} (${check.id}) returned no result`);
    const text = compactJsonText(textOf(result.content));
    assert(
      text.includes(check.expect),
      `${check.name} (${check.id}) result missing '${check.expect}': ${text.slice(0, 400)}`,
    );
    assert(
      result.isError === (check.error === true),
      `${check.name} (${check.id}) isError=${result.isError}`,
    );
  }
}

function fixtureRanges(manifest: Manifest, label: string) {
  const file = manifest.files.find((item) => item.path === fixturePath);
  assert(file, `${label} manifest missing sample file`);
  const right = file.commentableRanges.find((item) => item.side === "RIGHT");
  const left = file.commentableRanges.find((item) => item.side === "LEFT");
  assert(right, `${label} manifest missing RIGHT range`);
  assert(left || label !== "condensed", `${label} manifest missing LEFT range for base reads`);
  return { file, right, left: left as Range };
}

function offeredToolNames(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
  );
}

function toolResultsSinceLatestUser(messages: readonly Message[]): ToolResultMessage[] {
  const latestUser = messages.findLastIndex((message) => message.role === "user");
  return messages
    .slice(latestUser + 1)
    .filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function review(title: string, body: string) {
  return { summary: { title, body }, inlineFindings: [] };
}

function json(value: unknown): AssistantMessage {
  return fauxAssistantMessage(JSON.stringify(value));
}

/** Parses the pretty-printed JSON object after a prompt label; it ends at the first unindented `}`. */
function parsePromptJson<T>(prompt: string, label: string): T {
  const start = prompt.indexOf(label);
  assert(start !== -1, `prompt missing ${label.trim()}`);
  const end = prompt.indexOf("\n}", start);
  assert(end !== -1, `prompt JSON after ${label.trim()} is incomplete`);
  return JSON.parse(prompt.slice(start + label.length, end + 2)) as T;
}

/** Re-serializes JSON tool output without whitespace so checks do not depend on formatting. */
function compactJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** Joins a message's text parts; user and tool-result content may be a plain string or typed parts. */
function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Appends a `start` event now and returns a function that appends the matching `end` event. */
async function recordCallStart(callsDir: string, call: ModelCall, modelId: string) {
  const id = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const file = path.join(callsDir, `${id}.jsonl`);
  const event = {
    id,
    promptKind: call.kind,
    model: `deepseek/${modelId}`,
    repair: call.latest.startsWith(repairPromptPrefix),
    workspace: process.cwd(),
  };
  await appendFile(file, `${JSON.stringify({ ...event, phase: "start", time: Date.now() })}\n`);
  return () => appendFile(file, `${JSON.stringify({ id, phase: "end", time: Date.now() })}\n`);
}

async function assertSandboxIdentity(): Promise<void> {
  const identity = `${process.getuid?.()}:${process.getgid?.()}`;
  assert(identity === "1000:1000", `agent worker must run as 1000:1000, got ${identity}`);
  await expectPermissionDenied(() => chmod(process.cwd(), 0o755));
  await expectPermissionDenied(() =>
    writeFile(path.join(process.cwd(), ".pipr-isolation-probe"), "unexpected write"),
  );
  const tempProbe = path.join(Bun.env.TMPDIR ?? "/tmp", ".pipr-writable-probe");
  await writeFile(tempProbe, "ok");
  await rm(tempProbe);
}

async function expectPermissionDenied(run: () => Promise<unknown>): Promise<void> {
  const code = await run().then(
    () => "succeeded",
    (error: NodeJS.ErrnoException) => error.code,
  );
  assert(
    code === "EACCES" || code === "EPERM",
    `agent worker workspace write was not denied (${code})`,
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
