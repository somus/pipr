const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    Response.json({
      id: 42,
      path_with_namespace: "group/project",
    }),
});
const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reserved"),
});
const webhookPort = portReservation.port;
portReservation.stop(true);

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
    try {
      const response = await fetch(`http://127.0.0.1:${webhookPort}/healthz`);
      if (response.status === 200 && (await response.text()) === "OK") {
        console.log("container webhook health ok");
        healthy = true;
        break;
      }
    } catch {
      // The packaged CLI may still be resolving its repository and starting the listener.
    }
    await Bun.sleep(100);
  }
  if (!healthy) {
    if (webhook.exitCode === null) webhook.kill("SIGTERM");
    await webhook.exited;
    throw new Error(
      `packaged webhook server did not become healthy\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
    );
  }
} finally {
  if (webhook.exitCode === null) webhook.kill("SIGTERM");
  await webhook.exited;
  provider.stop(true);
}
