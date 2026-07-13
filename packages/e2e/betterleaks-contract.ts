type CheckOptions = {
  cwd: string;
  image: string;
};

const configPath = "/opt/pipr/packages/runtime/betterleaks.toml";
const licensePath = "/usr/local/share/licenses/betterleaks/LICENSE";

export async function checkBetterleaksContract(options: CheckOptions): Promise<void> {
  const dockerfile = await Bun.file(`${options.cwd}/Dockerfile`).text();
  const version = dockerfileVersion(dockerfile);
  const installedVersion = runContainer(options, ["version"]).stdout.trim();
  if (installedVersion !== version) {
    throw new Error(
      `Dockerfile Betterleaks version must match betterleaks version: expected '${version}', got '${installedVersion}'`,
    );
  }

  assertDockerfilePinsSupportedArchitectures(dockerfile);
  assertLicensePresent(options);
  await assertRedaction(options);
  await assertPiprSpanMapping(options);
  console.log(`Betterleaks contract ok: betterleaks ${version}; config=${configPath}`);
}

async function assertPiprSpanMapping(options: CheckOptions): Promise<void> {
  const script = `
    import { createBetterleaksSecretRedactor } from "/opt/pipr/packages/runtime/dist/internal/testing.mjs";
    const token = ["xoxb", "111111111111", "222222222222", "abcdefghijklmnopqrstuvwx"].join("-");
    const fixtures = [
      token,
      "first line\\nASCII before " + token + " after",
      "first line\\nUnicode 😀 é before " + token + " after",
    ];
    const redactor = createBetterleaksSecretRedactor();
    const results = await redactor.redact(fixtures);
    const expected = fixtures.map((fixture) => fixture.replace(token, "[redacted secret]"));
    if (results.some((result, index) => !result.detected || result.value !== expected[index])) {
      throw new Error("Pipr did not map Betterleaks spans onto publication text");
    }
  `;
  const result = Bun.spawnSync(
    ["docker", "run", "--rm", "--entrypoint", "bun", options.image, "-e", script],
    { cwd: options.cwd, env: Bun.env, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Pipr Betterleaks span mapping failed with ${result.exitCode}: ${result.stderr.toString()}`,
    );
  }
}

async function assertRedaction(options: CheckOptions): Promise<void> {
  const secret = ["xoxb", "111111111111", "222222222222", "abcdefghijklmnopqrstuvwx"].join("-");
  const scan = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--interactive",
      "--entrypoint",
      "betterleaks",
      options.image,
      "stdin",
      "--no-banner",
      "--redact=100",
      "--report-format=json",
      "--report-path=-",
      "--max-decode-depth=0",
      "--max-archive-depth=0",
      `--config=${configPath}`,
    ],
    {
      cwd: options.cwd,
      env: Bun.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  scan.stdin.write(`fixture=${secret}\n`);
  await scan.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    scan.exited,
    new Response(scan.stdout).text(),
    new Response(scan.stderr).text(),
  ]);
  assertFixtureExitCode(exitCode, stderr);
  assertFixtureSecretAbsent(secret, stdout, stderr);
  assertFixtureReport(stdout);
}

function assertFixtureExitCode(exitCode: number, stderr: string): void {
  if (exitCode !== 1) {
    throw new Error(`Betterleaks fixture scan expected exit 1, got ${exitCode}: ${stderr}`);
  }
}

function assertFixtureSecretAbsent(secret: string, stdout: string, stderr: string): void {
  if (stdout.includes(secret) || stderr.includes(secret)) {
    throw new Error("Betterleaks emitted the unredacted contract fixture");
  }
}

function assertFixtureReport(stdout: string): void {
  const report = JSON.parse(stdout) as Array<{ Secret?: string }>;
  if (report.length === 0 || report.some((finding) => finding.Secret !== "REDACTED")) {
    throw new Error("Betterleaks JSON report did not redact the contract fixture");
  }
}

function assertLicensePresent(options: CheckOptions): void {
  const result = Bun.spawnSync(
    ["docker", "run", "--rm", "--entrypoint", "test", options.image, "-s", licensePath],
    { cwd: options.cwd, env: Bun.env, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Betterleaks license is missing from ${licensePath}`);
  }
}

function assertDockerfilePinsSupportedArchitectures(dockerfile: string): void {
  const expectedPins = [
    "fbefc700a0bd4522cc952dd2a8f259cdb80526d7e60114aca19bb2d6fdc80f81",
    "bab9688ba968264ace67b608fc7a7d8f5e61218cde70029d32cbc894e3808fdf",
  ];
  const missing = expectedPins.filter((checksum) => !dockerfile.includes(checksum));
  if (missing.length > 0) {
    throw new Error(
      `Dockerfile is missing Betterleaks architecture checksum pins: ${missing.join(", ")}`,
    );
  }
}

function dockerfileVersion(dockerfile: string): string {
  const match = dockerfile.match(/ARG BETTERLEAKS_VERSION=([^\s]+)/);
  if (!match?.[1]) {
    throw new Error("Dockerfile does not pin BETTERLEAKS_VERSION");
  }
  return match[1];
}

function runContainer(options: CheckOptions, args: string[]): { stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    ["docker", "run", "--rm", "--entrypoint", "betterleaks", options.image, ...args],
    { cwd: options.cwd, env: Bun.env, stderr: "pipe", stdout: "pipe" },
  );
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `betterleaks ${args.join(" ")} failed with ${result.exitCode}: ${stderr || stdout}`,
    );
  }
  return { stdout, stderr };
}
