export type RunSelector = {
  host: "github" | "gitlab" | "azure-devops" | "bitbucket" | "gitea" | "forgejo" | "codeberg";
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
