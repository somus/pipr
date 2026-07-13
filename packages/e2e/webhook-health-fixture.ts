const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    Response.json({
      id: 42,
      path_with_namespace: "group/project",
    }),
});
const argumentSeparator = process.argv.indexOf("--");
const healthcheckCommand = process.argv.slice(argumentSeparator === -1 ? 2 : argumentSeparator + 1);
if (healthcheckCommand.length === 0) throw new Error("Compose healthcheck command is required");
const webhookPort = 8787;

const webhook = Bun.spawn(
  [
    "pipr",
    "webhook",
    "serve",
    "--host",
    "gitlab",
    "--repository",
    "group/project",
    "--workspace",
    "/workspace",
    "--database",
    "/home/bun/.tmp/webhook-health-e2e.sqlite",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(webhookPort),
  ],
  {
    env: {
      ...process.env,
      CI_API_V4_URL: `http://127.0.0.1:${provider.port}`,
      GITLAB_TOKEN: "fixture-token",
      PIPR_WEBHOOK_SECRET: "fixture-secret",
    },
    stderr: "pipe",
    stdout: "pipe",
  },
);
const stderr = new Response(webhook.stderr).text();
const stdout = new Response(webhook.stdout).text();

try {
  let healthy = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (webhook.exitCode !== null) break;
    const healthcheck = Bun.spawn(healthcheckCommand, { stderr: "ignore", stdout: "ignore" });
    if ((await healthcheck.exited) === 0) {
      console.log("container webhook Compose healthcheck ok");
      healthy = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!healthy) {
    if (webhook.exitCode === null) webhook.kill("SIGTERM");
    await webhook.exited;
    throw new Error(
      `Compose healthcheck did not pass against the packaged webhook server\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
    );
  }
} finally {
  if (webhook.exitCode === null) webhook.kill("SIGTERM");
  await webhook.exited;
  provider.stop(true);
}
