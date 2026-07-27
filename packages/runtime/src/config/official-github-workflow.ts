import {
  officialInitRecipeRequiresChecksPermission,
  officialInitRecipeWorkflowEnvSecrets,
} from "./recipes.js";

const defaultWorkflowActionRef = "somus/pipr@v0.6.3"; // x-release-please-version
const githubEnterpriseUploadArtifactAction = "actions/upload-artifact@v3.2.2-node20";

export type RenderOfficialGithubWorkflowOptions = {
  relativeConfigDir?: string;
  recipe?: string;
  minimal?: boolean;
  runtimeImage?: string;
  checkoutAction?: string;
  githubRunner?: string;
  githubEnterpriseServer?: boolean;
  includeReleasePleaseVersionMarker?: boolean;
};

/** Internal shared renderer for `pipr init` and generated recipe docs. */
export function renderOfficialGithubWorkflow(
  options: RenderOfficialGithubWorkflowOptions = {},
): string {
  const relativeConfigDir = options.relativeConfigDir ?? ".pipr";
  const githubRunner =
    options.githubRunner ?? (options.githubEnterpriseServer ? "self-hosted" : "ubuntu-latest");
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, reopened, ready_for_review]",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "  issues: write",
  ];
  if (officialInitRecipeRequiresChecksPermission(options.recipe)) {
    lines.push("  checks: write");
  }
  lines.push(
    "",
    "jobs:",
    "  review:",
    `    runs-on: ${JSON.stringify(githubRunner)}`,
    "    steps:",
    `      - uses: ${options.checkoutAction ?? "actions/checkout@v6"}`,
    "        with:",
    "          fetch-depth: 0",
  );
  if (!options.minimal) {
    lines.push(
      "      - uses: actions/cache@v4",
      "        with:",
      "          path: /home/runner/work/_temp/_github_home/.bun/install/cache",
      `          key: pipr-bun-${githubExpression(`hashFiles('${relativeConfigDir}/bun.lock')`)}`,
    );
  }
  const piprStep = options.runtimeImage
    ? [
        `      - uses: docker://${options.runtimeImage}`,
        "        id: pipr",
        "        with:",
        `          args: host-run --host github --config-dir ${relativeConfigDir}`,
      ]
    : [
        `      - uses: ${defaultWorkflowActionRef}${
          options.includeReleasePleaseVersionMarker ? " # x-release-please-version" : ""
        }`,
        "        id: pipr",
      ];
  lines.push(
    ...piprStep,
    "        env:",
    `          DEEPSEEK_API_KEY: ${githubExpression("secrets.DEEPSEEK_API_KEY")}`,
    `          GITHUB_TOKEN: ${githubExpression("github.token")}`,
    `          PIPR_RUN_AGE_RECIPIENTS: ${githubExpression("vars.PIPR_RUN_AGE_RECIPIENTS")}`,
  );
  for (const secret of officialInitRecipeWorkflowEnvSecrets(options.recipe)) {
    lines.push(`          ${secret.env}: ${githubExpression(`secrets.${secret.secret}`)}`);
  }
  if (!options.runtimeImage && relativeConfigDir !== ".pipr") {
    lines.push("        with:", `          config-dir: ${relativeConfigDir}`);
  }
  lines.push(
    "      - name: Upload Pipr run bundle",
    "        if: always() && steps.pipr.outputs.run-bundle-path != ''",
    `        uses: ${
      options.githubEnterpriseServer
        ? githubEnterpriseUploadArtifactAction
        : "actions/upload-artifact@v6"
    }`,
    "        with:",
    `          name: ${githubExpression("steps.pipr.outputs.run-artifact-name")}`,
    `          path: ${githubExpression("steps.pipr.outputs.run-bundle-path")}`,
    "          retention-days: 14",
    "          if-no-files-found: warn",
    "          include-hidden-files: true",
  );
  lines.push("");
  return lines.join("\n");
}

function githubExpression(expression: string): string {
  return `$${["{{ ", expression, " }}"].join("")}`;
}
