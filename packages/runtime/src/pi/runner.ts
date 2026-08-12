import path from "node:path";
import {
  assertPiAuthentication,
  buildPiArgs,
  buildPiEnv,
  mergePreparedPiTools,
} from "./cli-args.js";
import { type PreparedPiCustomTools, preparePiCustomTools } from "./custom-tools.js";
import {
  assertWorkspaceScope,
  createPiRunSandbox,
  createPiWorkspaceSnapshot,
  createReadOnlyWorkspace,
  removeSandboxRoot,
  resolvePiProcessIdentity,
  runProcess,
  sealPiRunSandbox,
} from "./process.js";
import { preparePiRuntimeReadTools } from "./runtime-tools.js";
import {
  defaultPiStreamLimits,
  type PiRunner,
  type PiRunOptions,
  type PiRunResult,
  type PiWorkspaceScope,
  type PreparedPiTools,
} from "./types.js";

export { createReadOnlyWorkspace };

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  return await runPiAttempt(options);
}

export function createScopedPiRunner(scope: PiWorkspaceScope): PiRunner {
  const normalizedScope = {
    ...scope,
    sourceWorkspace: path.resolve(scope.sourceWorkspace),
    workspace: path.resolve(scope.workspace),
  };
  return async (options) => await runPiAttempt(options, normalizedScope);
}

export async function withPiRunWorkspace<T>(
  options: Pick<PiRunOptions, "workspace" | "env">,
  run: (piRunner: PiRunner) => Promise<T>,
): Promise<T> {
  const processIdentity = resolvePiProcessIdentity(options.env ?? process.env);
  if (!processIdentity) {
    return await run(runPi);
  }
  const snapshot = await createPiWorkspaceSnapshot(options.workspace);
  try {
    return await run(
      createScopedPiRunner({
        sourceWorkspace: options.workspace,
        workspace: snapshot.workspace,
        processIdentity,
      }),
    );
  } finally {
    await removeSandboxRoot(snapshot.root);
  }
}

async function runPiAttempt(
  options: PiRunOptions,
  workspaceScope?: PiWorkspaceScope,
): Promise<PiRunResult> {
  assertPiAuthentication(options);
  const started = Date.now();
  const processIdentity = resolvePiProcessIdentity(options.env ?? process.env);
  assertWorkspaceScope(options.workspace, processIdentity, workspaceScope);
  const sandbox = await createPiRunSandbox(options.workspace, workspaceScope?.workspace);
  let preparedTools: PreparedPiTools | undefined;
  let preparedCustomTools: PreparedPiCustomTools | undefined;
  try {
    const runtimeRead = options.runtimeTools
      ? await preparePiRuntimeReadTools({
          root: sandbox.root,
          sourceWorkspace: options.workspace,
          request: options.runtimeTools,
        })
      : undefined;
    preparedCustomTools = options.customTools
      ? await preparePiCustomTools({
          root: sandbox.root,
          request: options.customTools,
        })
      : undefined;
    preparedTools = mergePreparedPiTools(runtimeRead, preparedCustomTools);
    const promptPath = path.join(sandbox.root, "prompt.md");
    await Bun.write(promptPath, options.prompt);
    const args = buildPiArgs(
      options.provider,
      `@${promptPath}`,
      sandbox.sessionDir,
      preparedTools,
      options.builtinTools,
    );
    await sealPiRunSandbox(sandbox, processIdentity);
    return await runProcess(options.piExecutable ?? "pi", args, {
      cwd: sandbox.workspace,
      env: buildPiEnv(options.provider, sandbox, options.env, preparedTools, options.piAgentDir),
      processIdentity,
      started,
      timeoutSeconds: options.timeoutSeconds,
      streamLimits: options.streamLimits ?? defaultPiStreamLimits,
      eventObserver: options.eventObserver,
      diffContext: options.diffContext,
    });
  } finally {
    await preparedCustomTools?.close();
    await removeSandboxRoot(sandbox.root);
  }
}
