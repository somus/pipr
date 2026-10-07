export const runHosts = [
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "gitea",
  "forgejo",
  "codeberg",
] as const;

export type RunHost = (typeof runHosts)[number];

export type RunProtection = "plaintext" | "metadata" | "age";

export type RunDiagnosticState =
  | "available"
  | "locked"
  | "not-captured"
  | "encryption-failed"
  | "size-limit";

export type RunSelector = {
  host: RunHost;
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
