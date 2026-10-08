import type { CodeHostId } from "@usepipr/runtime";

export type RunProtection = "plaintext" | "metadata" | "age";

export type RunDiagnosticState =
  | "available"
  | "locked"
  | "not-captured"
  | "encryption-failed"
  | "size-limit";

export type RunSelector = {
  host: CodeHostId;
  repository: string;
  changeNumber: number;
};

export type RunsListOptions = {
  pr: string;
  host?: string;
  repository?: string;
  kind?: string;
  status?: string;
  limit?: string;
  json?: boolean;
  store?: string;
};

export type RunsShowOptions = Omit<RunsListOptions, "pr"> & {
  pr?: string;
  timeline?: boolean;
  identity?: string[];
};

export type RunsDownloadOptions = {
  host?: string;
  repository?: string;
  output?: string;
  archive?: boolean;
  store?: string;
  identity?: string[];
};

export type RunsInspectOptions = {
  timeline?: boolean;
  identity?: string[];
  json?: boolean;
};

export type RunsKeygenOptions = {
  output?: string;
};

/** Selects the runs and webhook events whose Finding Outcome ledgers are read. */
export type RunsLedgerOptions = {
  host?: string;
  repository?: string;
  since?: string;
  limit?: string;
  eventLimit?: string;
  store?: string;
  webhookDb?: string;
};

export type RunsStatsOptions = RunsLedgerOptions & {
  groupBy?: string;
  json?: boolean;
};

export type RunsExportOptions = RunsLedgerOptions & {
  dataset: string;
  repo?: string;
  identity?: string[];
};
