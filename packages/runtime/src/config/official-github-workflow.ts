import { officialInitRecipeWorkflowEnvSecrets } from "./recipes.js";

const defaultWorkflowActionRef = "somus/pipr@v0.5.0"; // x-release-please-version

export type RenderOfficialGithubWorkflowOptions = {
  relativeConfigDir?: string;
  recipe?: string;
  minimal?: boolean;
  includeReleasePleaseVersionMarker?: boolean;
};

/** Internal shared renderer for `pipr init` and generated recipe docs. */
export function renderOfficialGithubWorkflow(
  options: RenderOfficialGithubWorkflowOptions = {},
): string {
  const relativeConfigDir = options.relativeConfigDir ?? ".pipr";
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "  checks: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
  ];
  if (!options.minimal) {
    lines.push(
      "      - uses: actions/cache@v4",
      "        with:",
      "          path: /home/runner/work/_temp/_github_home/.bun/install/cache",
      `          key: pipr-bun-${githubExpression(`hashFiles('${relativeConfigDir}/bun.lock')`)}`,
    );
  }
  lines.push(
    `      - uses: ${defaultWorkflowActionRef}${
      options.includeReleasePleaseVersionMarker ? " # x-release-please-version" : ""
    }`,
    "        id: pipr",
    "        env:",
    `          DEEPSEEK_API_KEY: ${githubExpression("secrets.DEEPSEEK_API_KEY")}`,
    `          GITHUB_TOKEN: ${githubExpression("github.token")}`,
  );
  for (const secret of officialInitRecipeWorkflowEnvSecrets(options.recipe)) {
    lines.push(`          ${secret.env}: ${githubExpression(`secrets.${secret.secret}`)}`);
  }
  if (relativeConfigDir !== ".pipr") {
    lines.push("        with:", `          config-dir: ${relativeConfigDir}`);
  }
  lines.push(
    "      - name: Upload Pipr run bundle",
    "        if: always() && steps.pipr.outputs.run-bundle-path != ''",
    "        uses: actions/upload-artifact@v6",
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
