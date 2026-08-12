export type { RuntimeLogRecord, RuntimeLogSink } from "../shared/logging.js";
export { runDryRunCommand } from "./commands-dry-run.js";
/** Composition root for hosted runs: wires adapters, recorder, and ports once. */
export { runHostRunCommand, runHostRunCommandWithDependencies } from "./commands-hosted.js";
export { runInitCommand } from "./commands-init.js";
export { runInspectCommand } from "./commands-inspect.js";
export { runLocalReviewCommand } from "./commands-local-review.js";
export { runValidateCommand } from "./commands-validate.js";
export type {
  DryRunCommandOptions,
  DryRunCommandResult,
  HostRunCommandOptions,
  HostRunCommandResult,
  InitCommandOptions,
  InspectCommandResult,
  LocalReviewCommandOptions,
  LocalReviewCommandResult,
  RuntimeCommandOptions,
} from "./types.js";
