import type { DiagnosticFindingLedger, RunBundleArtifact, RunBundleManifest } from "@usepipr/sdk";
import type { RuntimeLogSink } from "../shared/logging.js";
import type { RunObserver } from "./types.js";

export type RunFailureCategory = NonNullable<RunBundleManifest["failureCategory"]>;

export type RunRecorderFinish = {
  kind: RunBundleManifest["kind"];
  outcome: RunBundleManifest["outcome"];
  failureCategory?: RunFailureCategory;
  workId?: string;
  repository?: RunBundleManifest["repository"];
  provider?: RunBundleManifest["provider"];
  configVersion?: string;
  configHash?: string;
};

export type RunRecorder = {
  executionId: string;
  directory: string;
  logSink: RuntimeLogSink;
  observer: RunObserver;
  addArtifact(artifact: {
    kind: RunBundleArtifact["kind"];
    name: string;
    mediaType: string;
    content: string;
    sensitive: boolean;
  }): Promise<void>;
  /**
   * Writes the `ledger` artifact: events and evidence in diagnostic capture, public events only in
   * metadata capture.
   */
  recordLedger(ledger: DiagnosticFindingLedger): Promise<void>;
  discard(): Promise<void>;
  finish(result: RunRecorderFinish): Promise<void>;
};
