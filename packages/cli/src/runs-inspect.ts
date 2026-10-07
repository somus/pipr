import path from "node:path";
import { copyRunBundleInput } from "@usepipr/runtime";
import { withTemporaryRoot } from "./runs-sources.js";
import type { RunsInspectOptions } from "./runs-types.js";
import { renderDownloadedRun } from "./runs-view.js";

export async function runRunsInspect(
  inputPath: string,
  options: RunsInspectOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const source = path.resolve(context.cwd, inputPath);
  await withTemporaryRoot("pipr-runs-inspect-", async (temporaryRoot) => {
    const downloaded = await copyRunBundleInput(source, path.join(temporaryRoot, "downloaded"));
    await renderDownloadedRun(downloaded, options, context, temporaryRoot);
  });
}
