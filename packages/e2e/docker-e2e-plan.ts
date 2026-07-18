export type DockerE2EStep = {
  command: string[];
  env?: Record<string, string>;
  label: string;
};

export function createDockerE2EPlan(image: string): DockerE2EStep[] {
  return [
    {
      label: "Validating webhook Docker Compose deployment",
      command: [
        "docker",
        "compose",
        "--env-file",
        "deploy/webhook/.env.example",
        "--file",
        "deploy/webhook/compose.yml",
        "config",
        "--quiet",
      ],
      env: { PIPR_ENV_FILE: ".env.example" },
    },
    {
      label: `Building e2e Docker image: ${image}`,
      command: ["docker", "build", "--target", "e2e", "--tag", image, "."],
    },
    {
      label: `Running e2e container check with image: ${image}`,
      command: ["bun", "run", "--cwd", "packages/e2e", "check:container"],
      env: { PIPR_ACTION_IMAGE: image },
    },
    {
      label: `Running all real Action scenarios with act: ${image}`,
      command: ["bun", "run", "--cwd", "packages/e2e", "check:actions"],
      env: {
        PIPR_ACTION_IMAGE: image,
        PIPR_SKIP_ACTION_IMAGE_BUILD: "1",
      },
    },
  ];
}
