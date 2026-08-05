export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ReleaseOperations = {
  run(command: string, args: readonly string[], options?: { cwd?: string }): Promise<CommandResult>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  output(name: string, value: string): Promise<void>;
  log(message: string): Promise<void>;
};

type SecretOptions = {
  secretValues?: readonly string[];
};

export type ResolveReleaseOptions = SecretOptions & {
  eventMode: "manual" | "workflow-run";
  repository: string;
  manualTag?: string;
  workflowRunSha?: string;
  commitSubject?: string;
  pollAttempts?: number;
  pollDelayMilliseconds?: number;
};

export type VerifyReleaseTagOptions = SecretOptions & {
  tag: string;
};

export type DogfoodReleaseOptions = SecretOptions & {
  version: string;
  npmPollAttempts?: number;
  npmPollDelayMilliseconds?: number;
};

type PackageManifest = {
  version?: unknown;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

type ActionManifest = {
  runs?: { image?: unknown };
};

type GithubRelease = {
  tagName: string;
  isDraft: boolean;
};

const releaseSubjectPrefixes = ["chore(main): release ", "chore: release "] as const;
const defaultReleasePollAttempts = 60;
const defaultReleasePollDelayMilliseconds = 10_000;
const defaultNpmPollAttempts = 30;
const defaultNpmPollDelayMilliseconds = 2_000;
const dogfoodPaths = [
  ".pipr/package.json",
  ".pipr/bun.lock",
  ".github/workflows/pipr.yml",
] as const;

export async function resolveRelease(
  operations: ReleaseOperations,
  options: ResolveReleaseOptions,
): Promise<void> {
  let tag: string;
  if (options.eventMode === "manual") {
    tag = required(options.manualTag, "manual release tag");
  } else {
    const workflowRunSha = required(options.workflowRunSha, "workflow-run SHA");
    const commitSubject = required(options.commitSubject, "workflow-run commit subject");
    if (!releaseSubjectPrefixes.some((prefix) => commitSubject.startsWith(prefix))) {
      await operations.log("Commit is not a Release Please merge commit; skipping publish.");
      await operations.output("publish", "false");
      return;
    }

    await runChecked(operations, "git", ["fetch", "--force", "--tags", "origin"], options);
    tag = await pollForReleaseTag(operations, {
      attempts: options.pollAttempts ?? defaultReleasePollAttempts,
      delayMilliseconds: options.pollDelayMilliseconds ?? defaultReleasePollDelayMilliseconds,
      repository: options.repository,
      secretValues: options.secretValues,
      workflowRunSha,
    });
  }

  assertVersionTag(tag);
  await operations.output("publish", "true");
  await operations.output("tag", tag);
}

export async function verifyReleaseTag(
  operations: ReleaseOperations,
  options: VerifyReleaseTagOptions,
): Promise<void> {
  assertVersionTag(options.tag);
  const version = options.tag.slice(1);
  for (const manifestPath of [
    "package.json",
    "packages/sdk/package.json",
    "packages/runtime/package.json",
    "packages/cli/package.json",
  ]) {
    const manifest = parseJson<PackageManifest>(await operations.read(manifestPath), manifestPath);
    if (manifest.version !== version) {
      throw releaseError(
        `${manifestPath} version ${String(manifest.version)} must match release ${version}`,
        options.secretValues,
      );
    }
  }

  const action = Bun.YAML.parse(await operations.read("action.yml")) as ActionManifest;
  const expectedImage = `docker://ghcr.io/somus/pipr:v${version}`;
  if (action.runs?.image !== expectedImage) {
    throw releaseError(
      `action.yml image ${String(action.runs?.image)} must match release v${version}`,
      options.secretValues,
    );
  }

  await operations.output("version", version);
}

export async function dogfoodRelease(
  operations: ReleaseOperations,
  options: DogfoodReleaseOptions,
): Promise<void> {
  const branch = `dogfood-sdk-${options.version.replaceAll(".", "-")}`;
  await runChecked(operations, "git", ["fetch", "origin", "main"], options);
  await runChecked(operations, "git", ["switch", "-C", branch, "origin/main"], options);

  const rootPackage = parseJson<PackageManifest>(
    await operations.read("package.json"),
    "package.json",
  );
  if (rootPackage.version !== options.version) {
    await operations.log(
      `Skipping dogfood SDK update because main is ${String(rootPackage.version)}, not ${options.version}.`,
    );
    return;
  }

  await waitForNpmPackage(operations, options);
  const dogfoodPackagePath = ".pipr/package.json";
  const dogfoodPackage = parseJson<PackageManifest>(
    await operations.read(dogfoodPackagePath),
    dogfoodPackagePath,
  );
  dogfoodPackage.dependencies ??= {};
  dogfoodPackage.dependencies["@usepipr/sdk"] = options.version;
  await operations.write(dogfoodPackagePath, `${JSON.stringify(dogfoodPackage, null, 2)}\n`);

  await runChecked(operations, "bun", ["install", "--cwd", ".pipr"], options);
  await runChecked(operations, "bun", ["run", "sync:release-lockfile"], options);
  await runChecked(operations, "bun", ["run", "check:release-metadata"], options);

  const diff = await operations.run("git", ["diff", "--quiet", "--", ...dogfoodPaths]);
  if (diff.exitCode === 0) {
    await operations.log(`Dogfood SDK already matches ${options.version}.`);
    return;
  }
  if (diff.exitCode !== 1) throw commandError("git", ["diff", "--quiet"], diff, options);

  const initialState = await loadPrState(operations, branch, options);
  if (initialState === "MERGED") {
    await operations.log(`Dogfood SDK update PR for ${branch} is already merged.`);
    return;
  }

  await runChecked(operations, "git", ["config", "user.name", "github-actions[bot]"], options);
  await runChecked(
    operations,
    "git",
    ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
    options,
  );
  await runChecked(operations, "git", ["add", ...dogfoodPaths], options);
  await runChecked(
    operations,
    "git",
    ["commit", "-m", `chore: update dogfood SDK to ${options.version}`],
    options,
  );
  await runChecked(operations, "git", ["fetch", "origin", "main"], options);
  await runChecked(operations, "git", ["rebase", "origin/main"], options);
  await runChecked(
    operations,
    "git",
    ["-c", "core.hooksPath=/dev/null", "push", "--force-with-lease", "origin", `HEAD:${branch}`],
    options,
  );

  const bodyPath = ".git/pipr-dogfood-pr.md";
  await operations.write(bodyPath, dogfoodPrBody(options.version));
  const title = `chore: update dogfood SDK to ${options.version}`;
  const state = await loadPrState(operations, branch, options);
  if (state === "OPEN") {
    await runChecked(
      operations,
      "gh",
      ["pr", "edit", branch, "--title", title, "--body-file", bodyPath],
      options,
    );
  } else if (state === "MERGED") {
    await operations.log(`Dogfood SDK update PR for ${branch} is already merged.`);
    return;
  } else if (state === "CLOSED") {
    await runChecked(operations, "gh", ["pr", "reopen", branch], options);
    await runChecked(
      operations,
      "gh",
      ["pr", "edit", branch, "--title", title, "--body-file", bodyPath],
      options,
    );
  } else if (state === "") {
    const created = await runChecked(
      operations,
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        bodyPath,
      ],
      options,
    );
    const createdPr = redact(created.stdout.trim(), options.secretValues);
    await operations.log(createdPr || `Created dogfood SDK update PR for ${branch}.`);
  } else {
    throw releaseError(
      `Dogfood SDK update PR for ${branch} is ${state}; not updating it`,
      options.secretValues,
    );
  }
}

async function pollForReleaseTag(
  operations: ReleaseOperations,
  options: {
    attempts: number;
    delayMilliseconds: number;
    repository: string;
    secretValues?: readonly string[];
    workflowRunSha: string;
  },
): Promise<string> {
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const result = await operations.run("gh", [
      "release",
      "list",
      "--repo",
      options.repository,
      "--limit",
      "20",
      "--json",
      "tagName,isDraft",
    ]);
    if (result.exitCode !== 0) {
      await logReleaseLookupFailure(operations, result, attempt, options);
      continue;
    }
    const tag = await matchingReleaseTag(
      operations,
      result.stdout,
      options.workflowRunSha,
      options,
    );
    if (tag) return tag;
    await operations.log(
      `No published release for CI head ${options.workflowRunSha} yet; waiting.`,
    );
    await operations.sleep(options.delayMilliseconds);
  }
  throw releaseError(
    `No published release for release commit ${options.workflowRunSha} after waiting; failing so publish is not silently lost.`,
    options.secretValues,
  );
}

async function logReleaseLookupFailure(
  operations: ReleaseOperations,
  result: CommandResult,
  attempt: number,
  options: {
    attempts: number;
    delayMilliseconds: number;
    secretValues?: readonly string[];
  },
): Promise<void> {
  const failure = redact(commandOutput(result), options.secretValues);
  const hasAttemptsRemaining = attempt < options.attempts;
  const outcome = hasAttemptsRemaining ? "retrying" : "no attempts remain";
  await operations.log(`gh release list failed (${failure}); ${outcome}.`);
  if (hasAttemptsRemaining) await operations.sleep(options.delayMilliseconds);
}

async function matchingReleaseTag(
  operations: ReleaseOperations,
  contents: string,
  workflowRunSha: string,
  options: SecretOptions,
): Promise<string | undefined> {
  for (const release of parseGithubReleases(contents)) {
    if (release.isDraft) continue;
    const commit = await operations.run("git", ["rev-list", "-n", "1", release.tagName]);
    if (commit.exitCode !== 0) {
      const failure = redact(commandOutput(commit), options.secretValues);
      await operations.log(
        `git rev-list failed for release tag ${release.tagName} (${failure}); skipping.`,
      );
      continue;
    }
    if (commit.stdout.trim() === workflowRunSha) return release.tagName;
  }
  return undefined;
}

function parseGithubReleases(contents: string): GithubRelease[] {
  const releases = parseJson<unknown>(contents, "gh release list output");
  if (!Array.isArray(releases)) {
    throw new Error("gh release list output must be an array");
  }
  return releases.map((release) => {
    if (
      !isRecord(release) ||
      typeof release.tagName !== "string" ||
      typeof release.isDraft !== "boolean"
    ) {
      throw new Error("gh release list output contains an invalid release");
    }
    return { isDraft: release.isDraft, tagName: release.tagName };
  });
}

function parsePrList(contents: string): Array<{ state: string }> {
  const prs = parseJson<unknown>(contents, "gh pr list output");
  if (!Array.isArray(prs)) throw new Error("gh pr list output must be an array");
  return prs.map((pr) => {
    if (!isRecord(pr) || typeof pr.state !== "string") {
      throw new Error("gh pr list output contains an invalid PR");
    }
    return { state: pr.state };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitForNpmPackage(
  operations: ReleaseOperations,
  options: DogfoodReleaseOptions,
): Promise<void> {
  const attempts = options.npmPollAttempts ?? defaultNpmPollAttempts;
  const delay = options.npmPollDelayMilliseconds ?? defaultNpmPollDelayMilliseconds;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await operations.run("npm", [
      "view",
      `@usepipr/sdk@${options.version}`,
      "version",
    ]);
    if (result.exitCode === 0) return;
    if (attempt < attempts) await operations.sleep(delay);
  }
  throw releaseError(
    `@usepipr/sdk@${options.version} was not visible on npm after waiting.`,
    options.secretValues,
  );
}

async function loadPrState(
  operations: ReleaseOperations,
  branch: string,
  options: SecretOptions,
): Promise<string> {
  const result = await runChecked(
    operations,
    "gh",
    ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "state"],
    options,
  );
  const prs = parsePrList(result.stdout);
  const state = prs[0]?.state;
  if (state === undefined) return "";
  if (typeof state !== "string") {
    throw releaseError("gh pr list returned a non-string PR state", options.secretValues);
  }
  return state;
}

async function runChecked(
  operations: ReleaseOperations,
  command: string,
  args: readonly string[],
  options: SecretOptions,
): Promise<CommandResult> {
  const result = await operations.run(command, args);
  if (result.exitCode !== 0) throw commandError(command, args, result, options);
  return result;
}

function commandError(
  command: string,
  args: readonly string[],
  result: CommandResult,
  options: SecretOptions,
): Error {
  const detail = commandOutput(result);
  return releaseError(`${command} ${args.join(" ")} failed: ${detail}`, options.secretValues);
}

function commandOutput(result: CommandResult): string {
  const streams = [
    ["stderr", result.stderr.trim()],
    ["stdout", result.stdout.trim()],
  ] as const;
  const output = streams
    .filter(([, contents]) => contents.length > 0)
    .map(([name, contents]) => `${name}: ${contents}`)
    .join("\n");
  return output || `exit ${result.exitCode}`;
}

function releaseError(message: string, secretValues: readonly string[] = []): Error {
  return new Error(redact(message, secretValues));
}

function redact(message: string, secretValues: readonly string[] = []): string {
  let redacted = message;
  for (const secret of secretValues) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertVersionTag(tag: string): void {
  if (!tag.startsWith("v")) throw new Error(`release tag must start with v: ${tag}`);
}

function parseJson<T>(contents: string, source: string): T {
  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function dogfoodPrBody(version: string): string {
  return `## Summary

- Updates dogfood \`.pipr\` to the just-published \`@usepipr/sdk@${version}\`.
- Refreshes \`.pipr/bun.lock\` after npm publish.
- Pins the self-review workflow to the just-published Pipr Action.

## Verification

- \`bun run check:release-metadata\`
`;
}
