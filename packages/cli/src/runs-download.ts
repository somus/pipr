import { constants as fsConstants } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import path from "node:path";
import { copyValidatedRunBundle, openRunBundlePackage } from "@usepipr/runtime";
import { resolveIdentityContents } from "./runs-identity.js";
import { resolveRepositorySelector } from "./runs-selector.js";
import {
  requireAvailableRun,
  runSources,
  selectRunByExecutionId,
  validExecutionId,
  withTemporaryRoot,
} from "./runs-sources.js";
import type { RunsDownloadOptions } from "./runs-types.js";

export async function runRunsDownload(
  executionId: string,
  options: RunsDownloadOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  validExecutionId(executionId);
  const destination = path.resolve(context.cwd, options.output ?? `pipr-run-${executionId}`);
  const selector = await resolveRepositorySelector({ ...options, cwd: context.cwd }).catch(
    () => undefined,
  );
  const selected = await selectRunByExecutionId(
    executionId,
    await runSources(options.store, context, selector),
  );
  requireAvailableRun(selected, executionId);
  await withTemporaryRoot("pipr-runs-download-", async (temporaryRoot) => {
    const downloaded = await selected.archiveSource.download(
      { ...selected.ref, preserveArchive: options.archive },
      path.join(temporaryRoot, executionId),
    );
    if (downloaded.envelope?.protection === "age") {
      const identities = await resolveIdentityContents(options.identity, context);
      if (identities.values.length === 0) {
        throw new Error(
          `Pipr run ${executionId} is encrypted; pass --identity <path> or set PIPR_RUN_AGE_IDENTITY`,
        );
      }
      if (!downloaded.packageDirectory) {
        throw new Error("Encrypted Run Bundle package is missing its ciphertext directory");
      }
      await openRunBundlePackage({
        packageDirectory: downloaded.packageDirectory,
        destination,
        identities: identities.values,
      });
    } else {
      await copyValidatedRunBundle(downloaded.directory, destination);
    }
    console.log(destination);
    if (downloaded.archivePath) {
      const archivePath = `${destination}${path.extname(downloaded.archivePath) || ".archive"}`;
      await copyFile(downloaded.archivePath, archivePath, fsConstants.COPYFILE_EXCL);
      await chmod(archivePath, 0o600);
      console.log(archivePath);
    }
  });
}
