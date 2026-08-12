import { spawn } from "node:child_process";

export type BoundedProcessResult = {
  stdout: string;
  stdoutBytes: number;
  stderr: string;
  exitCode: number;
};

export type BoundedProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  errors: {
    spawn: (error: unknown) => unknown;
    timeout: () => unknown;
    outputLimit: () => unknown;
  };
};

export async function runBoundedProcess(
  command: [string, ...string[]],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => fail(options.errors.timeout()), options.timeoutMs);
    child.on("error", (error) => fail(options.errors.spawn(error)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.stdoutLimitBytes) {
        fail(options.errors.outputLimit());
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.stderrLimitBytes) {
        fail(options.errors.outputLimit());
        return;
      }
      stderr.push(chunk);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stdoutBytes,
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? -1,
      });
    });
  });
}
