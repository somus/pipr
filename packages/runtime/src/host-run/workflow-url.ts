import { ciRunFromEnvironment } from "../hosts/ci-run.js";

export type FailureAction = {
  label: string;
  url: string;
};

export function failureActionFromEnvironment(
  host: string,
  env: NodeJS.ProcessEnv,
): FailureAction | undefined {
  if (host !== "github") {
    return undefined;
  }
  const url = ciRunFromEnvironment(host, env)?.runUrl;
  return url ? { label: "Open workflow to rerun failed jobs", url } : undefined;
}
