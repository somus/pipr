#!/usr/bin/env bun

const image = process.env.PIPR_TEST_DOCS_IMAGE ?? "pipr-docs:e2e";
const container = `pipr-docs-e2e-${process.pid}`;

run(["docker", "build", "--file", "Dockerfile.docs", "--tag", image, "."]);
run([
  "docker",
  "run",
  "--detach",
  "--rm",
  "--name",
  container,
  "--publish",
  "127.0.0.1::80",
  image,
]);

try {
  const portOutput = runOutput(["docker", "port", container, "80/tcp"]);
  const port = portOutput.trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`could not determine docs container port from '${portOutput.trim()}'`);
  const origin = `http://127.0.0.1:${port}`;

  await waitForDocs(origin);
  await assertContent(origin, "/");
  await assertContent(origin, "/docs");

  const install = await fetch(`${origin}/install.sh`);
  if (install.status !== 200 || !(await install.text()).startsWith("#!/")) {
    throw new Error("docs image did not serve the install script at /install.sh");
  }

  console.log(`docs image smoke passed: ${image}`);
} finally {
  Bun.spawnSync(["docker", "rm", "--force", container], {
    stderr: "ignore",
    stdout: "ignore",
  });
}

async function waitForDocs(origin: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(250);
  }
  throw new Error(`docs container did not become ready: ${String(lastError)}`);
}

async function assertContent(origin: string, pathname: string): Promise<void> {
  const response = await fetch(`${origin}${pathname}`);
  const body = await response.text();
  if (!response.ok || body.trim().length === 0) {
    throw new Error(`${pathname} returned HTTP ${response.status} without usable content`);
  }
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stderr: "inherit", stdout: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${result.exitCode}`);
  }
}

function runOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `${command.join(" ")} failed`);
  }
  return result.stdout.toString();
}
