import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import { runAgentWorker } from "./worker.js";

type AgentWorkerProcessOptions = {
  store?: string;
  authFile?: string;
  /** Module whose default export returns providers that replace built-in ones, for scripted model fixtures. */
  providerModule?: string;
  /** Path passed to the provider module's default export. */
  providerConfig?: string;
  /** Abort work a failed predecessor left unfinished instead of resuming it. */
  abandonUnfinished?: boolean;
};

const agentWorkerUsage = [
  "Usage: pipr agent-worker [--store <path>] [--auth-file <path>] [--provider-module <path> [--provider-config <path>]] [--abandon-unfinished]",
  "",
  "Internal: runs Pi agent conversations for the pipr supervisor over newline-delimited JSON on stdio.",
].join("\n");

/** Entry for `pipr agent-worker`: serves the supervisor on stdio until it closes stdin or sends shutdown. */
export async function runAgentWorkerCommand(argv: readonly string[]): Promise<void> {
  const options = parseAgentWorkerArgs(argv);
  if (options === "help") {
    console.log(agentWorkerUsage);
    return;
  }
  await runAgentWorkerProcess(options);
}

async function runAgentWorkerProcess(options: AgentWorkerProcessOptions): Promise<void> {
  await runAgentWorker({
    input: Bun.stdin.stream(),
    write: (line) => {
      process.stdout.write(line);
    },
    env: process.env,
    storePath: options.store,
    authFile: options.authFile,
    abandonUnfinished: options.abandonUnfinished === true,
    providers: options.providerModule
      ? await loadProviders(options.providerModule, options.providerConfig)
      : [],
  });
}

function parseAgentWorkerArgs(argv: readonly string[]): AgentWorkerProcessOptions | "help" {
  const options: AgentWorkerProcessOptions = {};
  const flags: Record<string, Exclude<keyof AgentWorkerProcessOptions, "abandonUnfinished">> = {
    "--store": "store",
    "--auth-file": "authFile",
    "--provider-module": "providerModule",
    "--provider-config": "providerConfig",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--abandon-unfinished") {
      options.abandonUnfinished = true;
      continue;
    }
    const key = flags[arg];
    const value = argv[index + 1];
    if (!key || value === undefined) {
      throw new Error(`pipr agent-worker received unsupported argument '${arg}'`);
    }
    options[key] = path.resolve(value);
    index += 1;
  }
  return options;
}

async function loadProviders(modulePath: string, config: string | undefined): Promise<Provider[]> {
  const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new Error(
      "agent worker provider module must default-export a function returning providers",
    );
  }
  const providers = (await loaded.default(config)) as Provider | Provider[];
  return Array.isArray(providers) ? providers : [providers];
}
