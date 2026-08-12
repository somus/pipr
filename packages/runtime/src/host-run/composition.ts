import type { CodeHostAdapter } from "../hosts/types.js";
import type { RunObserver } from "../observability/types.js";
import type { PiRunner } from "../pi/types.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { SecretRedactor } from "../shared/secret-redaction.js";
import { createHostRunAdapter } from "./adapter.js";
import type { HostRunCommandDependencyOptions } from "./types.js";

/** Workspace + mode fields shared by hosted command entrypoints. */
export type HostRunWorkspace = {
  rootDir: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  eventPath?: string;
};

/** Narrow injectable ports wired once at the host-run composition root. */
export type HostRunPorts = {
  adapter: CodeHostAdapter;
  piExecutable?: string;
  piRunner?: PiRunner;
  secretRedactor?: SecretRedactor;
  runObserver?: RunObserver;
};

/** Composed host-run runtime passed to entry modules instead of the options bag. */
export type HostRunServices = HostRunWorkspace &
  HostRunPorts & {
    log: RuntimeLog;
  };

export function composeHostRunPorts(
  options: HostRunCommandDependencyOptions,
  overrides: {
    runObserver?: RunObserver;
  } = {},
): HostRunPorts {
  return {
    adapter: createHostRunAdapter({
      env: options.env,
      host: options.host,
      hostAdapter: options.hostAdapter,
    }),
    ...(options.piExecutable !== undefined ? { piExecutable: options.piExecutable } : {}),
    ...(options.piRunner !== undefined ? { piRunner: options.piRunner } : {}),
    ...(options.secretRedactor !== undefined ? { secretRedactor: options.secretRedactor } : {}),
    ...(overrides.runObserver !== undefined
      ? { runObserver: overrides.runObserver }
      : options.runObserver !== undefined
        ? { runObserver: options.runObserver }
        : {}),
  };
}

export function composeHostRunWorkspace(
  options: HostRunCommandDependencyOptions,
): HostRunWorkspace {
  return {
    rootDir: options.rootDir,
    configDir: options.configDir,
    env: options.env ?? process.env,
    dryRun: options.dryRun,
    ...(options.eventPath !== undefined ? { eventPath: options.eventPath } : {}),
  };
}

export function composeHostRunServices(options: {
  workspace: HostRunWorkspace;
  ports: HostRunPorts;
  log: RuntimeLog;
}): HostRunServices {
  return {
    ...options.workspace,
    ...options.ports,
    log: options.log,
  };
}
