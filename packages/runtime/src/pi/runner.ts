import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compact, isPlainObject } from "lodash-es";
import type { DiffManifest, ProviderConfig } from "../types.js";
import type { PiReadOnlyToolName } from "./contract.js";
import {
  type PiCustomToolRequest,
  type PreparedPiCustomTools,
  preparePiCustomTools,
} from "./custom-tools.js";
import { toPiProviderInvocation } from "./provider.js";
import { type PreparedPiRuntimeReadTools, preparePiRuntimeReadTools } from "./runtime-tools.js";

export type PiRunOptions = {
  workspace: string;
  provider: ProviderConfig;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  piExecutable?: string;
  timeoutSeconds?: number;
  builtinTools?: readonly PiReadOnlyToolName[];
  runtimeTools?: {
    manifest: DiffManifest;
    toolResponseMaxBytes: number;
  };
  customTools?: PiCustomToolRequest;
};

export type PiRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

type PiRunSandbox = {
  root: string;
  workspace: string;
  home: string;
  sessionDir: string;
  tmp: string;
};

type PreparedPiTool = PreparedPiRuntimeReadTools | PreparedPiCustomTools;

export type PreparedPiTools = {
  extensionPath: string;
  runtimeRead?: PreparedPiRuntimeReadTools;
  custom?: PreparedPiCustomTools;
  toolNames: readonly string[];
};

const piprJsonSystemPrompt = [
  "You are a strict JSON API for pipr.",
  "Return exactly one JSON value matching the requested schema.",
  "The first non-whitespace character must be { or [ and the last non-whitespace character must be } or ].",
  "Do not include Markdown, code fences, prose, explanations, or leading/trailing text.",
].join(" ");
const ignoredWorkspacePaths = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  ".fallow",
  "coverage",
]);

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const started = Date.now();
  const sandbox = await createPiRunSandbox(options.workspace);
  let preparedTools: PreparedPiTools | undefined;
  try {
    const runtimeRead = options.runtimeTools
      ? await preparePiRuntimeReadTools({
          root: sandbox.root,
          sourceWorkspace: options.workspace,
          request: options.runtimeTools,
        })
      : undefined;
    const customTools = options.customTools
      ? await preparePiCustomTools({ root: sandbox.root, request: options.customTools })
      : undefined;
    preparedTools = mergePreparedPiTools(runtimeRead, customTools);
    const promptPath = path.join(sandbox.root, "prompt.md");
    await Bun.write(promptPath, options.prompt);
    const args = buildPiArgs(
      options.provider,
      `@${promptPath}`,
      sandbox.sessionDir,
      preparedTools,
      options.builtinTools,
    );
    const result = await runProcess(options.piExecutable ?? "pi", args, {
      cwd: sandbox.workspace,
      env: buildPiEnv(options.provider, sandbox, options.env, preparedTools),
      started,
      timeoutSeconds: options.timeoutSeconds,
    });
    return result.exitCode === 0
      ? { ...result, stdout: extractAssistantTextFromJsonEvents(result.stdout) ?? result.stdout }
      : result;
  } finally {
    await preparedTools?.custom?.close();
    await chmodRecursive(sandbox.root, 0o755);
    await rm(sandbox.root, { recursive: true, force: true });
  }
}

export function buildPiArgs(
  provider: ProviderConfig,
  prompt: string,
  sessionDir = ".pipr/pi-sessions",
  runtimeTools?: PreparedPiTools,
  builtinTools?: readonly PiReadOnlyToolName[],
): string[] {
  const invocation = toPiProviderInvocation(provider);
  const toolNames = [...(builtinTools ?? invocation.tools), ...(runtimeTools?.toolNames ?? [])];
  return [
    "--provider",
    invocation.provider,
    "--model",
    invocation.model,
    "--system-prompt",
    piprJsonSystemPrompt,
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--session-dir",
    sessionDir,
    "--tools",
    toolNames.join(","),
    ...(runtimeTools ? ["--extension", runtimeTools.extensionPath] : []),
    "--no-context-files",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--thinking",
    invocation.thinking,
    prompt,
  ];
}

function buildPiEnv(
  provider: ProviderConfig,
  sandbox: Pick<PiRunSandbox, "home" | "sessionDir" | "tmp">,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  runtimeTools?: PreparedPiTools,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: sandbox.home,
    PI_CODING_AGENT_DIR: path.join(sandbox.home, ".pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: sandbox.sessionDir,
    PI_TELEMETRY: "0",
    PIPR_PROVIDER_ID: provider.id,
    PIPR_PROVIDER_API_KEY_ENV: provider.apiKeyEnv,
    TMPDIR: sandbox.tmp,
    USER: "pipr",
  };
  if (runtimeTools?.runtimeRead) {
    env.PIPR_RUNTIME_TOOLS_DATA = runtimeTools.runtimeRead.dataPath;
  }
  if (runtimeTools?.custom) {
    env.PIPR_CUSTOM_TOOLS_DATA = runtimeTools.custom.dataPath;
    env.PIPR_CUSTOM_TOOLS_BRIDGE_URL = runtimeTools.custom.bridgeUrl;
    env.PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN = runtimeTools.custom.bridgeToken;
  }
  for (const key of ["BUN_INSTALL", "LANG", "PATH"]) {
    copyEnvValue(env, sourceEnv, key);
  }
  copyEnvValue(env, sourceEnv, provider.apiKeyEnv);
  return env;
}

function mergePreparedPiTools(
  runtimeRead: PreparedPiRuntimeReadTools | undefined,
  custom: PreparedPiCustomTools | undefined,
): PreparedPiTools | undefined {
  const tools = compact([runtimeRead, custom]);
  const first = tools[0];
  if (!first) {
    return undefined;
  }
  assertSharedExtensionPath(tools);
  return {
    extensionPath: first.extensionPath,
    runtimeRead,
    custom,
    toolNames: tools.flatMap((tool) => [...tool.toolNames]),
  };
}

function assertSharedExtensionPath(tools: PreparedPiTool[]): void {
  const extensionPaths = new Set(tools.map((tool) => tool.extensionPath));
  if (extensionPaths.size > 1) {
    throw new Error("pipr runtime and custom tools must use the same Pi extension");
  }
}

async function createPiRunSandbox(workspace: string): Promise<PiRunSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-"));
  const runWorkspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const sessionDir = path.join(root, "sessions");
  const tmp = path.join(root, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(tmp, { recursive: true });
  await copyWorkspace(workspace, runWorkspace);
  await chmodRecursive(runWorkspace, 0o555);
  return { root, workspace: runWorkspace, home, sessionDir, tmp };
}

export async function createReadOnlyWorkspace(workspace: string): Promise<string> {
  const destination = await mkdtemp(path.join(os.tmpdir(), "pipr-workspace-"));
  await copyWorkspace(workspace, destination);
  await chmodRecursive(destination, 0o555);
  return destination;
}

async function copyWorkspace(sourceWorkspace: string, destination: string): Promise<void> {
  await cp(sourceWorkspace, destination, {
    recursive: true,
    filter: async (source) => {
      const relative = path.relative(sourceWorkspace, source);
      if (!relative) {
        return true;
      }
      const first = relative.split(path.sep)[0];
      return !ignoredWorkspacePaths.has(first ?? "") && !(await lstat(source)).isSymbolicLink();
    },
  });
}

function copyEnvValue(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, key: string): void {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

async function chmodRecursive(target: string, mode: number): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    return;
  }
  await chmod(target, mode);
  if (!stats.isDirectory()) {
    return;
  }
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await chmodRecursive(path.join(target, entry.name), mode);
  }
}

function extractAssistantTextFromJsonEvents(stdout: string): string | undefined {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (!isPlainObject(value)) {
        return undefined;
      }
      events.push(value as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  const hasTypedEvent = events.some((event) => typeof event.type === "string");
  if (!hasTypedEvent) {
    return undefined;
  }
  let text: string | undefined;
  for (const event of events) {
    text = assistantTextFromEvent(event) ?? text;
  }
  return text;
}

function assistantTextFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "message_end" || event.type === "turn_end") {
    return assistantMessageText(event.message);
  }
  if (event.type === "agent_end") {
    return lastAssistantMessageText(event.messages);
  }
}

function lastAssistantMessageText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  let text: string | undefined;
  for (const message of messages) {
    text = assistantMessageText(message) ?? text;
  }
  return text;
}

function assistantMessageText(message: unknown): string | undefined {
  if (!isPlainObject(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") {
    return undefined;
  }
  return textContent(record.content);
}

function textContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!isPlainObject(block)) {
        return "";
      }
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; started: number; timeoutSeconds?: number },
): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    if (options.timeoutSeconds !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
      }, options.timeoutSeconds * 1000);
    }
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        stderr += `${stderr ? "\n" : ""}Pi timed out after ${options.timeoutSeconds}s`;
      }
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        durationMs: Date.now() - options.started,
      });
    });
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : "";
    if (code === "ESRCH") {
      return;
    }
  }
}
