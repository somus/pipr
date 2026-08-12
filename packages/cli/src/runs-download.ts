import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyValidatedRunBundle, openRunBundlePackage } from "@usepipr/runtime";
import { resolveIdentityContents } from "./runs-identity.js";
import { resolveRepositorySelector } from "./runs-selector.js";
import {
  collectExactRecord,
  runSources,
  unavailableRunMessage,
  withLookupErrors,
} from "./runs-sources.js";
import type { RunsDownloadOptions } from "./runs-types.js";

export async function runRunsDownload(
  executionId: string,
  options: RunsDownloadOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(executionId)) {
    throw new Error("Execution ID must be a 32-character lowercase hexadecimal trace ID");
  }
  const destination = path.resolve(context.cwd, options.output ?? `pipr-run-${executionId}`);
  const selector = await resolveRepositorySelector({ ...options, cwd: context.cwd }).catch(
    () => undefined,
  );
  const collected = await collectExactRecord(await runSources(options.store, context, selector), {
    executionId,
    kind: "all",
    limit: 1000,
  });
  const selected = collected.records.find((record) => record.executionId === executionId);
  if (!selected) {
    throw new Error(
      withLookupErrors(
        `Pipr run ${executionId} was not found in local or GitHub storage`,
        collected.errors,
      ),
    );
  }
  if (selected.state !== "available") {
    throw new Error(unavailableRunMessage(selected, executionId));
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runs-download-"));
  try {
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
