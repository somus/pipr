import path from "node:path";
import { parseRunBundleRecipients, prepareRunBundlePackage } from "./protected-package.js";
import { resolveRunStoreDirectory } from "./retention-store.js";
import { buildRunArtifactName } from "./run-artifact-name.js";

/** A finalized Run Bundle package ready for provider artifact upload. */
export type PublishedRunBundle = {
  executionId: string;
  /** Package directory, relative to the workspace root when it lives inside it. */
  bundlePath: string;
  artifactName: string;
};

/** Packages a finalized Run Bundle into the run store and names its provider artifact. */
export async function publishRunBundle(options: {
  bundleDirectory: string;
  executionId: string;
  changeNumber?: number;
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<PublishedRunBundle> {
  const prepared = await prepareRunBundlePackage({
    bundleDirectory: options.bundleDirectory,
    destinationRoot: resolveRunStoreDirectory({
      env: options.env,
      mode: "workspace",
      rootDir: options.rootDir,
    }),
    recipients: parseRunBundleRecipients(options.env.PIPR_RUN_AGE_RECIPIENTS),
  });
  const relative = path.relative(options.rootDir, prepared.directory);
  return {
    executionId: options.executionId,
    bundlePath: relative && !relative.startsWith("..") ? relative : prepared.directory,
    artifactName: buildRunArtifactName({
      executionId: options.executionId,
      protection: prepared.envelope.protection,
      ...(options.changeNumber ? { changeNumber: options.changeNumber } : {}),
    }),
  };
}
