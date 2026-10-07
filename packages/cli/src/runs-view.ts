import path from "node:path";
import {
  type DownloadedBundle,
  diagnoseRunBundle,
  loadValidatedRunBundle,
  openRunBundlePackage,
  type RunDiagnosis,
  type ValidatedRunBundle,
} from "@usepipr/runtime";
import { resolveIdentityContents } from "./runs-identity.js";
import { printDiagnosis } from "./runs-print.js";
import type {
  RunDiagnosticState,
  RunProtection,
  RunsInspectOptions,
  RunsShowOptions,
} from "./runs-types.js";

export async function renderDownloadedRun(
  downloaded: DownloadedBundle,
  options: RunsInspectOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
  temporaryRoot: string,
): Promise<void> {
  const view = await openDownloadedRunForShow(downloaded, options, {
    ...context,
    temporaryRoot,
  });
  const bundle = view.bundle;
  const diagnosis = diagnoseRunBundle(bundle);
  if (options.json) return printRunJson(bundle, diagnosis, view.protection, view.diagnostic);
  printDiagnosis(bundle.manifest, diagnosis, options.timeline ? bundle.spans : undefined);
  if (view.diagnostic === "locked") {
    console.log("Diagnostics: locked; pass --identity <path> to decrypt diagnostic artifacts");
  } else if (view.diagnostic !== "available") {
    console.log(`Diagnostics: ${view.diagnostic}`);
  }
}

function printRunJson(
  bundle: ValidatedRunBundle,
  diagnosis: RunDiagnosis,
  protection: RunProtection,
  diagnostic: RunDiagnosticState,
): void {
  console.log(
    JSON.stringify(
      {
        formatVersion: 1,
        protection,
        diagnostic,
        manifest: bundle.manifest,
        spans: bundle.spans,
        diagnosis,
        artifacts: bundle.manifest.artifacts,
      },
      null,
      2,
    ),
  );
}

async function openDownloadedRunForShow(
  downloaded: DownloadedBundle,
  options: RunsShowOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string; temporaryRoot: string },
): Promise<{
  bundle: ValidatedRunBundle;
  protection: RunProtection;
  diagnostic: RunDiagnosticState;
}> {
  if (!downloaded.envelope) {
    return {
      bundle: await loadValidatedRunBundle(downloaded.directory),
      protection: "plaintext",
      diagnostic: "available",
    };
  }
  if (downloaded.envelope.protection === "age" && downloaded.packageDirectory) {
    const identities = await resolveIdentityContents(options.identity, context);
    if (identities.values.length > 0) {
      try {
        const opened = await openRunBundlePackage({
          packageDirectory: downloaded.packageDirectory,
          destination: path.join(context.temporaryRoot, "diagnostic"),
          identities: identities.values,
        });
        return {
          bundle: opened.bundle,
          protection: "age",
          diagnostic: "available",
        };
      } catch (error) {
        if (identities.explicit) throw error;
      }
    }
    return {
      bundle: await loadValidatedRunBundle(downloaded.directory),
      protection: "age",
      diagnostic: "locked",
    };
  }
  return {
    bundle: await loadValidatedRunBundle(downloaded.directory),
    protection: "metadata",
    diagnostic: downloaded.envelope.diagnosticState,
  };
}
