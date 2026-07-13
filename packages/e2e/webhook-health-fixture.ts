const argumentSeparator = process.argv.indexOf("--");
const healthcheckCommand = process.argv.slice(argumentSeparator === -1 ? 2 : argumentSeparator + 1);
if (healthcheckCommand.length === 0) throw new Error("Compose healthcheck command is required");

const webhookPort = 8787;
const providers = [
  {
    host: "gitlab",
    repository: "group/project",
    env: { GITLAB_TOKEN: "fixture-token" },
  },
  {
    host: "azure-devops",
    repository: "repository",
    env: {
      AZURE_DEVOPS_ORGANIZATION: "organization",
      AZURE_DEVOPS_PROJECT: "project",
      AZURE_DEVOPS_TOKEN: "fixture-token",
      PIPR_AZURE_SUBSCRIPTION_ID: "subscription-id",
    },
  },
  {
    host: "bitbucket",
    repository: "repository",
    env: {
      BITBUCKET_API_TOKEN: "fixture-token",
      BITBUCKET_EMAIL: "pipr@example.com",
      BITBUCKET_REPO_SLUG: "repository",
      BITBUCKET_WORKSPACE: "workspace",
    },
  },
] as const;

for (const provider of providers) await assertProviderHealth(provider);

async function assertProviderHealth(provider: (typeof providers)[number]): Promise<void> {
  const webhook = Bun.spawn(
    [
      "/usr/local/bin/bun",
      "--preload",
      "/opt/pipr/packages/e2e/webhook-fetch-mock.ts",
      "/opt/pipr/packages/cli/dist/main.mjs",
      "webhook",
      "serve",
      "--host",
      provider.host,
      "--repository",
      provider.repository,
      "--workspace",
      "/workspace",
      "--database",
      `/home/bun/.tmp/webhook-health-${provider.host}.sqlite`,
      "--hostname",
      "127.0.0.1",
      "--port",
      String(webhookPort),
    ],
    {
      env: {
        ...process.env,
        ...provider.env,
        PIPR_WEBHOOK_SECRET: "fixture-secret",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const stderr = new Response(webhook.stderr).text();
  const stdout = new Response(webhook.stdout).text();

  try {
    await waitForHealth(provider.host, webhook, stdout, stderr);
  } finally {
    await stopWebhook(webhook);
  }
}

async function waitForHealth(
  host: string,
  webhook: Bun.Subprocess,
  stdout: Promise<string>,
  stderr: Promise<string>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (webhook.exitCode !== null) break;
    if (await healthcheckPasses()) {
      console.log(`container webhook ${host} Compose healthcheck ok`);
      return;
    }
    await Bun.sleep(100);
  }
  await stopWebhook(webhook);
  throw new Error(
    `${host} Compose healthcheck did not pass against the packaged webhook server\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
  );
}

async function healthcheckPasses(): Promise<boolean> {
  const healthcheck = Bun.spawn(healthcheckCommand, { stderr: "ignore", stdout: "ignore" });
  return (await healthcheck.exited) === 0;
}

async function stopWebhook(webhook: Bun.Subprocess): Promise<void> {
  if (webhook.exitCode === null) webhook.kill("SIGTERM");
  await webhook.exited;
}
