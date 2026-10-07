import type { CodeHostAdapter } from "../hosts/types.js";
import type { RunObserver } from "../observability/types.js";
import type { PiProviderModule, PiRunner } from "../pi/types.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { SecretRedactor } from "../shared/secret-redaction.js";

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
  piProviderModule?: PiProviderModule;
  /** Root for per-change-request agent stores; unset runs keep stores in the temporary sandbox. */
  piStoreRoot?: string;
  piRunner?: PiRunner;
  secretRedactor?: SecretRedactor;
  runObserver?: RunObserver;
};

/** Composed host-run runtime passed to entry modules instead of the options bag. */
export type HostRunServices = HostRunWorkspace &
  HostRunPorts & {
    log: RuntimeLog;
  };
