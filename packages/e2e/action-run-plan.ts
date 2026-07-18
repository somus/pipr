export const containerArchitecture = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";

export function actArguments(input: {
  eventFile: string;
  runnerImage: string;
  workflowFile: string;
}): string[] {
  return [
    "pull_request",
    "-W",
    `.github/workflows/${input.workflowFile}`,
    "-e",
    input.eventFile,
    "-P",
    `ubuntu-latest=${input.runnerImage}`,
    "--container-architecture",
    containerArchitecture,
    "--bind",
    "--pull=false",
    "--rm",
  ];
}
