import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyRunBundleInput } from "@usepipr/runtime";
import type { RunsInspectOptions } from "./runs-types.js";
import { renderDownloadedRun } from "./runs-view.js";

export async function runRunsInspect(
  inputPath: string,
  options: RunsInspectOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const source = path.resolve(context.cwd, inputPath);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runs-inspect-"));
  try {
    const destination = path.join(temporaryRoot, "downloaded");
    const downloaded = await copyRunBundleInput(source, destination);
    await renderDownloadedRun(downloaded, options, context, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
