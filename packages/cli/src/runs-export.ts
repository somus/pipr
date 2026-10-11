import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { labelFindingOutcomes } from "@usepipr/runtime";
import {
  type FindingDatasetCase,
  type FindingEvidence,
  findingDatasetCaseSchema,
} from "@usepipr/sdk";
import { resolveIdentityContents } from "./runs-identity.js";
import { collectFindingLedgers } from "./runs-ledgers.js";
import type { RunsExportOptions } from "./runs-types.js";

type LabeledFinding = ReturnType<typeof labelFindingOutcomes>[number];

type SkipReason = "no-evidence" | "commit-unavailable" | "file-unavailable";

const skipDescriptions: Record<SkipReason, string> = {
  "no-evidence": "without decrypted evidence",
  "commit-unavailable": "commit unavailable",
  "file-unavailable": "file unavailable",
};

/**
 * Writes one labeled eval case per fixed, still-valid, or dismissed finding, joining decrypted
 * ledger evidence with the finding's file at the reviewed base and head commits.
 */
export async function runRunsExport(
  options: RunsExportOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const identities = await resolveIdentityContents(options.identity, context);
  if (identities.values.length === 0) {
    throw new Error(
      "pipr runs export --dataset requires a Run Bundle identity to read finding evidence; pass --identity <path> or set PIPR_RUN_AGE_IDENTITY",
    );
  }
  const collected = await collectFindingLedgers(options, context, identities.values);
  for (const error of collected.errors) {
    console.error(`pipr warning ${error.source}: ${error.message}`);
  }
  const datasetDirectory = path.resolve(context.cwd, options.dataset);
  const repository = path.resolve(context.cwd, options.repo ?? ".");
  await mkdir(datasetDirectory, { recursive: true, mode: 0o700 });
  await chmod(datasetDirectory, 0o700);
  const cases: Array<{ id: string; label: FindingDatasetCase["label"]; file: string }> = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  for (const labeled of labelFindingOutcomes(collected.sources)) {
    // Evidence from the run the case names as its source, so the commits match that run.
    const evidence = collected.evidence.get(labeled.findingId)?.get(labeled.executionId);
    const built = evidence
      ? await datasetCase(labeled, evidence, repository)
      : ("no-evidence" as const);
    if (typeof built === "string") {
      skipped[built] = (skipped[built] ?? 0) + 1;
      continue;
    }
    const file = `${built.id}.json`;
    await writePrivateFile(
      path.join(datasetDirectory, file),
      `${JSON.stringify(built, null, 2)}\n`,
    );
    cases.push({ id: built.id, label: built.label, file });
  }
  await writePrivateFile(
    path.join(datasetDirectory, "index.json"),
    `${JSON.stringify({ formatVersion: 1, cases, skipped }, null, 2)}\n`,
  );
  console.log(`Exported ${cases.length} dataset cases to ${datasetDirectory}`);
  const skippedEntries = Object.entries(skipped) as Array<[SkipReason, number]>;
  if (skippedEntries.length > 0) {
    console.log(
      `Skipped: ${skippedEntries.map(([reason, count]) => `${count} ${skipDescriptions[reason]}`).join(", ")}`,
    );
  }
}

/** Writes owner-only; `mode` applies only on creation, so an existing file is also restricted. */
async function writePrivateFile(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function datasetCase(
  labeled: LabeledFinding,
  evidence: FindingEvidence,
  repository: string,
): Promise<FindingDatasetCase | SkipReason> {
  const files = await caseFiles(evidence, repository);
  if (typeof files === "string") return files;
  return findingDatasetCaseSchema.parse({
    formatVersion: 1,
    id: labeled.findingId,
    description: `${labeled.label} finding from ${labeled.agent ?? "Pipr"} on ${evidence.path}:${evidence.startLine}-${evidence.endLine}`,
    label: labeled.label,
    source: {
      findingId: labeled.findingId,
      executionId: labeled.executionId,
      workId: labeled.workId,
      baseSha: evidence.baseSha,
      headSha: evidence.headSha,
      ...optional({
        configHash: labeled.configHash,
        agent: labeled.agent,
        model: labeled.model,
      }),
      facets: labeled.facets,
    },
    finding: {
      path: evidence.path,
      side: evidence.side,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      body: evidence.body,
      ...optional({ suggestedFix: evidence.suggestedFix }),
    },
    ...files,
    expected: expectedOutcome(labeled.label, evidence),
    modes: ["live"],
  } satisfies FindingDatasetCase);
}

/**
 * The finding's file at the reviewed base and head; added or deleted files have one side, and a
 * renamed file is read from its previous path at the base, which the head deletes.
 */
async function caseFiles(
  evidence: FindingEvidence,
  repository: string,
): Promise<Pick<FindingDatasetCase, "baseFiles" | "headFiles" | "deletedFiles"> | SkipReason> {
  const shas = [evidence.baseSha, evidence.headSha];
  const commits = await Promise.all(shas.map((sha) => commitExists(repository, sha)));
  if (commits.includes(false)) return "commit-unavailable";
  const basePath = (await previousPath(repository, evidence)) ?? evidence.path;
  const [base, head] = await Promise.all([
    git(repository, ["show", `${evidence.baseSha}:${basePath}`]),
    git(repository, ["show", `${evidence.headSha}:${evidence.path}`]),
  ]);
  if (base === undefined && head === undefined) return "file-unavailable";
  return caseFileSides({ path: basePath, content: base }, { path: evidence.path, content: head });
}

function caseFileSides(
  base: { path: string; content: string | undefined },
  head: { path: string; content: string | undefined },
): Pick<FindingDatasetCase, "baseFiles" | "headFiles" | "deletedFiles"> {
  const deletedFiles = [
    ...(head.content === undefined ? [head.path] : []),
    ...(base.content !== undefined && base.path !== head.path ? [base.path] : []),
  ];
  return {
    baseFiles: base.content === undefined ? {} : { [base.path]: base.content },
    headFiles: head.content === undefined ? {} : { [head.path]: head.content },
    ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
  };
}

/** The base path of a file that git detects as renamed to the finding's path between the commits. */
async function previousPath(
  repository: string,
  evidence: FindingEvidence,
): Promise<string | undefined> {
  const diff = await git(repository, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    evidence.baseSha,
    evidence.headSha,
  ]);
  const fields = diff?.split("\0") ?? [];
  // Each entry is a status then one path, or two for renames and copies.
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? "";
    const paths = /^[RC]/.test(status) ? 2 : 1;
    if (status.startsWith("R") && fields[index + 2] === evidence.path) return fields[index + 1];
    index += 1 + paths;
  }
  return undefined;
}

/** Fixed and still-valid findings expect the finding at its range; dismissed expect none. */
function expectedOutcome(
  label: FindingDatasetCase["label"],
  evidence: FindingEvidence,
): FindingDatasetCase["expected"] {
  if (label === "dismissed") return { findings: [], maxInlineFindings: 0 };
  return {
    findings: [
      {
        path: evidence.path,
        line: evidence.startLine,
        keywords: [],
        selection: { startLine: evidence.startLine, endLine: evidence.endLine },
      },
    ],
    maxInlineFindings: 1,
  };
}

function optional<T extends Record<string, string | undefined>>(values: T) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [Key in keyof T]?: string;
  };
}

async function commitExists(repository: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  return (await git(repository, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined;
}

/** Runs git and returns stdout, or undefined when git fails. */
async function git(repository: string, args: string[]): Promise<string | undefined> {
  const child = Bun.spawn(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return exitCode === 0 ? stdout : undefined;
}
