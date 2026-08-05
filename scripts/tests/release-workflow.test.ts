import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CommandResult,
  dogfoodRelease,
  type ReleaseOperations,
  resolveRelease,
  verifyReleaseTag,
} from "../release/workflow.js";

type CommandCall = {
  command: string;
  args: readonly string[];
  options?: { cwd?: string };
};

class FakeReleaseOperations implements ReleaseOperations {
  readonly calls: CommandCall[] = [];
  readonly outputs: Array<[string, string]> = [];
  readonly logs: string[] = [];
  readonly sleeps: number[] = [];
  readonly writes = new Map<string, string>();
  readonly responses = new Map<string, CommandResult[]>();
  readonly files = new Map<string, string>();

  respond(command: string, args: readonly string[], ...responses: CommandResult[]): void {
    this.responses.set(key(command, args), [...responses]);
  }

  async run(
    command: string,
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    const queue = this.responses.get(key(command, args));
    return queue?.shift() ?? success();
  }

  async read(file: string): Promise<string> {
    const contents = this.files.get(file);
    if (contents === undefined) throw new Error(`unexpected read: ${file}`);
    return contents;
  }

  async write(file: string, contents: string): Promise<void> {
    this.writes.set(file, contents);
    this.files.set(file, contents);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
  }

  async output(name: string, value: string): Promise<void> {
    this.outputs.push([name, value]);
  }

  async log(message: string): Promise<void> {
    this.logs.push(message);
  }
}

const repoRoot = path.resolve(import.meta.dirname, "../..");
const releaseSha = "a".repeat(40);
const repository = "somus/pipr";

function success(stdout = ""): CommandResult {
  return { exitCode: 0, stderr: "", stdout };
}

function failure(stderr = "failed"): CommandResult {
  return { exitCode: 1, stderr, stdout: "" };
}

function key(command: string, args: readonly string[]): string {
  return JSON.stringify([command, args]);
}

function releaseList(...releases: Array<{ tagName: string; isDraft?: boolean }>): string {
  return JSON.stringify(releases.map((release) => ({ isDraft: false, ...release })));
}

function packageJson(version: string, dependencies?: Record<string, string>): string {
  return `${JSON.stringify({ name: "fixture", version, dependencies }, null, 2)}\n`;
}

function verifyFiles(operations: FakeReleaseOperations, version = "1.2.3"): void {
  operations.files.set("package.json", packageJson(version));
  operations.files.set("packages/sdk/package.json", packageJson(version));
  operations.files.set("packages/runtime/package.json", packageJson(version));
  operations.files.set("packages/cli/package.json", packageJson(version));
  operations.files.set(
    "action.yml",
    `name: Pipr Review\nruns:\n  using: docker\n  image: docker://ghcr.io/somus/pipr:v${version}\n`,
  );
}

function dogfoodOperations(
  options: { mainVersion?: string; packageVersion?: string } = {},
): FakeReleaseOperations {
  const operations = new FakeReleaseOperations();
  operations.files.set("package.json", packageJson(options.mainVersion ?? "1.2.3"));
  operations.files.set(
    ".pipr/package.json",
    packageJson("0.0.0", { "@usepipr/sdk": options.packageVersion ?? "1.2.2" }),
  );
  operations.respond("git", ["diff", "--quiet", "--", ...dogfoodPaths], failure("changed"));
  operations.respond("gh", prListArgs, success("[]"), success("[]"));
  return operations;
}

const dogfoodPaths = [
  ".pipr/package.json",
  ".pipr/bun.lock",
  ".github/workflows/pipr.yml",
] as const;
const branch = "dogfood-sdk-1-2-3";
const prListArgs = [
  "pr",
  "list",
  "--head",
  branch,
  "--state",
  "all",
  "--limit",
  "1",
  "--json",
  "state",
] as const;

describe("resolveRelease", () => {
  it("skips a workflow-run commit that is not a Release Please merge without polling", async () => {
    const operations = new FakeReleaseOperations();

    await resolveRelease(operations, {
      eventMode: "workflow-run",
      repository,
      workflowRunSha: releaseSha,
      commitSubject: "fix: ordinary change",
    });

    expect(operations.outputs).toEqual([["publish", "false"]]);
    expect(operations.calls).toEqual([]);
  });

  it("finds the non-draft release attached to the exact CI SHA and ignores unrelated tags", async () => {
    const operations = new FakeReleaseOperations();
    operations.respond(
      "gh",
      ["release", "list", "--repo", repository, "--limit", "20", "--json", "tagName,isDraft"],
      success(
        releaseList(
          { tagName: "v9.9.9" },
          { tagName: "v1.2.3" },
          { tagName: "v2.0.0", isDraft: true },
        ),
      ),
    );
    operations.respond("git", ["rev-list", "-n", "1", "v9.9.9"], success("b".repeat(40)));
    operations.respond("git", ["rev-list", "-n", "1", "v1.2.3"], success(`${releaseSha}\n`));

    await resolveRelease(operations, {
      eventMode: "workflow-run",
      repository,
      workflowRunSha: releaseSha,
      commitSubject: "chore(main): release 1.2.3",
    });

    expect(operations.outputs).toEqual([
      ["publish", "true"],
      ["tag", "v1.2.3"],
    ]);
    expect(operations.calls[0]).toEqual({
      command: "git",
      args: ["fetch", "--force", "--tags", "origin"],
      options: undefined,
    });
    expect(operations.calls.some((call) => call.args.includes("v2.0.0"))).toBe(false);
  });

  it("accepts the unscoped Release Please subject and fails after bounded polling", async () => {
    const operations = new FakeReleaseOperations();
    const listArgs = [
      "release",
      "list",
      "--repo",
      repository,
      "--limit",
      "20",
      "--json",
      "tagName,isDraft",
    ];
    operations.respond("gh", listArgs, success("[]"), success("[]"));

    await expect(
      resolveRelease(operations, {
        eventMode: "workflow-run",
        repository,
        workflowRunSha: releaseSha,
        commitSubject: "chore: release 1.2.3",
        pollAttempts: 2,
        pollDelayMilliseconds: 7,
      }),
    ).rejects.toThrow("No published release for release commit");
    expect(operations.sleeps).toEqual([7, 7]);
    expect(operations.outputs).toEqual([]);
  });

  it("retries a transient GitHub release lookup failure", async () => {
    const operations = new FakeReleaseOperations();
    const listArgs = [
      "release",
      "list",
      "--repo",
      repository,
      "--limit",
      "20",
      "--json",
      "tagName,isDraft",
    ];
    operations.respond(
      "gh",
      listArgs,
      failure("temporary API failure"),
      success(releaseList({ tagName: "v1.2.3" })),
    );
    operations.respond("git", ["rev-list", "-n", "1", "v1.2.3"], success(releaseSha));

    await resolveRelease(operations, {
      eventMode: "workflow-run",
      repository,
      workflowRunSha: releaseSha,
      commitSubject: "chore(main): release 1.2.3",
      pollAttempts: 2,
      pollDelayMilliseconds: 7,
    });

    expect(operations.sleeps).toEqual([7]);
    expect(operations.logs).toContain(
      "gh release list failed (stderr: temporary API failure); retrying.",
    );
    expect(operations.outputs).toEqual([
      ["publish", "true"],
      ["tag", "v1.2.3"],
    ]);
  });

  it("logs and redacts tag resolution failures before continuing", async () => {
    const operations = new FakeReleaseOperations();
    const token = "git_tag_resolution_secret";
    operations.respond(
      "gh",
      ["release", "list", "--repo", repository, "--limit", "20", "--json", "tagName,isDraft"],
      success(releaseList({ tagName: "v1.2.3" })),
    );
    operations.respond(
      "git",
      ["rev-list", "-n", "1", "v1.2.3"],
      failure(`cannot resolve ${token}`),
    );

    await expect(
      resolveRelease(operations, {
        eventMode: "workflow-run",
        repository,
        workflowRunSha: releaseSha,
        commitSubject: "chore(main): release 1.2.3",
        pollAttempts: 1,
        pollDelayMilliseconds: 0,
        secretValues: [token],
      }),
    ).rejects.toThrow("No published release for release commit");

    expect(operations.logs).toContain(
      "git rev-list failed for release tag v1.2.3 (stderr: cannot resolve [REDACTED]); skipping.",
    );
    expect(operations.logs.join("\n")).not.toContain(token);
  });

  it("rejects malformed GitHub release payloads", async () => {
    const operations = new FakeReleaseOperations();
    operations.respond(
      "gh",
      ["release", "list", "--repo", repository, "--limit", "20", "--json", "tagName,isDraft"],
      success('{"tagName":"v1.2.3","isDraft":false}'),
    );

    await expect(
      resolveRelease(operations, {
        eventMode: "workflow-run",
        repository,
        workflowRunSha: releaseSha,
        commitSubject: "chore(main): release 1.2.3",
      }),
    ).rejects.toThrow("gh release list output must be an array");
  });

  it("redacts diagnostics through exhausted GitHub lookup failures", async () => {
    const operations = new FakeReleaseOperations();
    const token = "ghp_release_lookup_secret";
    const listArgs = [
      "release",
      "list",
      "--repo",
      repository,
      "--limit",
      "20",
      "--json",
      "tagName,isDraft",
    ];
    operations.respond("gh", listArgs, failure(`first ${token}`), {
      exitCode: 1,
      stderr: "second warning",
      stdout: `second ${token}`,
    });

    await expect(
      resolveRelease(operations, {
        eventMode: "workflow-run",
        repository,
        workflowRunSha: releaseSha,
        commitSubject: "chore(main): release 1.2.3",
        pollAttempts: 2,
        pollDelayMilliseconds: 7,
        secretValues: [token],
      }),
    ).rejects.toThrow("No published release for release commit");

    expect(operations.sleeps).toEqual([7, 7]);
    expect(operations.logs).toEqual([
      "gh release list failed (stderr: first [REDACTED]); retrying.",
      "gh release list failed (stderr: second warning\nstdout: second [REDACTED]); no attempts remain.",
    ]);
    expect(operations.logs.join("\n")).not.toContain(token);
  });

  it("uses a valid manual tag directly and writes every output through the port", async () => {
    const operations = new FakeReleaseOperations();

    await resolveRelease(operations, {
      eventMode: "manual",
      manualTag: "v1.2.3",
      repository,
    });

    expect(operations.calls).toEqual([]);
    expect(operations.outputs).toEqual([
      ["publish", "true"],
      ["tag", "v1.2.3"],
    ]);
  });

  it("rejects a manual tag without the v prefix", async () => {
    const operations = new FakeReleaseOperations();

    await expect(
      resolveRelease(operations, { eventMode: "manual", manualTag: "1.2.3", repository }),
    ).rejects.toThrow("release tag must start with v: 1.2.3");
    expect(operations.outputs).toEqual([]);
  });
});

describe("verifyReleaseTag", () => {
  it("writes the version when root, package, and Action versions agree", async () => {
    const operations = new FakeReleaseOperations();
    verifyFiles(operations);

    await verifyReleaseTag(operations, { tag: "v1.2.3" });

    expect(operations.outputs).toEqual([["version", "1.2.3"]]);
  });

  it("reports precise root and package mismatches without exposing secrets", async () => {
    const rootOperations = new FakeReleaseOperations();
    verifyFiles(rootOperations);
    rootOperations.files.set("package.json", packageJson("1.2.2"));
    await expect(verifyReleaseTag(rootOperations, { tag: "v1.2.3" })).rejects.toThrow(
      "package.json version 1.2.2 must match release 1.2.3",
    );

    const packageOperations = new FakeReleaseOperations();
    verifyFiles(packageOperations);
    packageOperations.files.set("packages/runtime/package.json", packageJson("1.2.2"));
    await expect(
      verifyReleaseTag(packageOperations, {
        tag: "v1.2.3",
        secretValues: ["top-secret"],
      }),
    ).rejects.toThrow("packages/runtime/package.json version 1.2.2 must match release 1.2.3");
  });

  it("reports a stale Action image structurally", async () => {
    const operations = new FakeReleaseOperations();
    verifyFiles(operations);
    operations.files.set(
      "action.yml",
      "name: Pipr Review\nruns:\n  using: docker\n  image: docker://ghcr.io/somus/pipr:v1.2.2\n",
    );

    await expect(verifyReleaseTag(operations, { tag: "v1.2.3" })).rejects.toThrow(
      "action.yml image docker://ghcr.io/somus/pipr:v1.2.2 must match release v1.2.3",
    );
  });
});

describe("dogfoodRelease", () => {
  it("skips a stale main release before npm, GitHub, or repository mutation", async () => {
    const operations = dogfoodOperations({ mainVersion: "1.2.4" });

    await dogfoodRelease(operations, { version: "1.2.3" });

    expect(operations.calls.map(({ command, args }) => [command, args])).toEqual([
      ["git", ["fetch", "origin", "main"]],
      ["git", ["switch", "-C", branch, "origin/main"]],
    ]);
    expect(operations.writes.size).toBe(0);
  });

  it("retries npm visibility and then succeeds", async () => {
    const operations = dogfoodOperations();
    const npmArgs = ["view", "@usepipr/sdk@1.2.3", "version"];
    operations.respond(
      "npm",
      npmArgs,
      failure("not found"),
      failure("not found"),
      success("1.2.3"),
    );

    await dogfoodRelease(operations, { version: "1.2.3", npmPollDelayMilliseconds: 5 });

    expect(operations.calls.filter((call) => call.command === "npm")).toHaveLength(3);
    expect(operations.sleeps).toEqual([5, 5]);
  });

  it("fails when npm visibility polling is exhausted", async () => {
    const operations = dogfoodOperations();
    const npmArgs = ["view", "@usepipr/sdk@1.2.3", "version"];
    operations.respond("npm", npmArgs, failure(), failure());

    await expect(
      dogfoodRelease(operations, {
        version: "1.2.3",
        npmPollAttempts: 2,
        npmPollDelayMilliseconds: 5,
      }),
    ).rejects.toThrow("@usepipr/sdk@1.2.3 was not visible on npm after waiting");
    expect(operations.sleeps).toEqual([5]);
  });

  it("skips commit, push, and PR mutation when the expected files have no diff", async () => {
    const operations = dogfoodOperations();
    operations.respond("git", ["diff", "--quiet", "--", ...dogfoodPaths], success());

    await dogfoodRelease(operations, { version: "1.2.3" });

    expect(operations.calls.some((call) => call.args[0] === "commit")).toBe(false);
    expect(operations.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(operations.calls.some((call) => call.command === "gh")).toBe(false);
  });

  it("exits before push when the existing PR is merged", async () => {
    const operations = dogfoodOperations();
    operations.respond("gh", prListArgs, success('[{"state":"MERGED"}]'));

    await dogfoodRelease(operations, { version: "1.2.3" });

    expect(operations.calls.some((call) => call.args[0] === "push")).toBe(false);
  });

  for (const scenario of [
    { initial: "OPEN", expected: "edit" },
    { initial: "CLOSED", expected: "reopen" },
    { initial: "", expected: "create" },
  ]) {
    it(`${scenario.initial || "missing"} PR is reconciled with ${scenario.expected}`, async () => {
      const operations = dogfoodOperations();
      const state = scenario.initial ? `[{"state":"${scenario.initial}"}]` : "[]";
      operations.respond("gh", prListArgs, success(state), success(state));

      await dogfoodRelease(operations, { version: "1.2.3" });

      expect(
        operations.calls.some(
          (call) =>
            call.command === "gh" && call.args[0] === "pr" && call.args[1] === scenario.expected,
        ),
      ).toBe(true);
      if (scenario.initial === "CLOSED") {
        expect(operations.calls.some((call) => call.args[1] === "edit")).toBe(true);
      }
    });
  }

  it("reloads PR state after push and rejects an unexpected state", async () => {
    const operations = dogfoodOperations();
    operations.respond(
      "gh",
      prListArgs,
      success('[{"state":"OPEN"}]'),
      success('[{"state":"DRAFT"}]'),
    );

    await expect(dogfoodRelease(operations, { version: "1.2.3" })).rejects.toThrow(
      `Dogfood SDK update PR for ${branch} is DRAFT; not updating it`,
    );
    expect(
      operations.calls.filter((call) => key(call.command, call.args) === key("gh", prListArgs)),
    ).toHaveLength(2);
  });

  it("rejects malformed PR lookup payloads before mutation", async () => {
    const operations = dogfoodOperations();
    operations.respond("gh", prListArgs, success('{"state":"OPEN"}'));

    await expect(dogfoodRelease(operations, { version: "1.2.3" })).rejects.toThrow(
      "gh pr list output must be an array",
    );
    expect(operations.calls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("propagates complete PR lookup and push failures", async () => {
    const lookupOperations = dogfoodOperations();
    lookupOperations.respond("gh", prListArgs, {
      exitCode: 1,
      stderr: "GitHub warning",
      stdout: "GitHub unavailable",
    });
    let lookupError = "";
    try {
      await dogfoodRelease(lookupOperations, { version: "1.2.3" });
    } catch (error) {
      lookupError = error instanceof Error ? error.message : String(error);
    }
    expect(lookupError).toContain("stderr: GitHub warning");
    expect(lookupError).toContain("stdout: GitHub unavailable");

    const pushOperations = dogfoodOperations();
    pushOperations.respond(
      "git",
      ["-c", "core.hooksPath=/dev/null", "push", "--force-with-lease", "origin", `HEAD:${branch}`],
      failure("push rejected"),
    );
    await expect(dogfoodRelease(pushOperations, { version: "1.2.3" })).rejects.toThrow(
      "push rejected",
    );
  });

  it("updates, validates, stages, pushes, and creates the dogfood PR in order", async () => {
    const operations = dogfoodOperations();

    await dogfoodRelease(operations, { version: "1.2.3" });

    expect(JSON.parse(operations.writes.get(".pipr/package.json") ?? "")).toMatchObject({
      dependencies: { "@usepipr/sdk": "1.2.3" },
    });
    expect(operations.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["git", "fetch", "origin", "main"],
      ["git", "switch", "-C", branch, "origin/main"],
      ["npm", "view", "@usepipr/sdk@1.2.3", "version"],
      ["bun", "install", "--cwd", ".pipr"],
      ["bun", "run", "sync:release-lockfile"],
      ["bun", "run", "check:release-metadata"],
      ["git", "diff", "--quiet", "--", ...dogfoodPaths],
      ["gh", ...prListArgs],
      ["git", "config", "user.name", "github-actions[bot]"],
      ["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
      ["git", "add", ...dogfoodPaths],
      ["git", "commit", "-m", "chore: update dogfood SDK to 1.2.3"],
      ["git", "fetch", "origin", "main"],
      ["git", "rebase", "origin/main"],
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--force-with-lease",
        "origin",
        `HEAD:${branch}`,
      ],
      ["gh", ...prListArgs],
      [
        "gh",
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        "chore: update dogfood SDK to 1.2.3",
        "--body-file",
        ".git/pipr-dogfood-pr.md",
      ],
    ]);
    expect(operations.writes.get(".git/pipr-dogfood-pr.md")).toContain("@usepipr/sdk@1.2.3");
  });

  it("never exposes token values in commands, writes, or errors", async () => {
    const operations = dogfoodOperations();
    const token = "ghp_fake_secret_token";
    operations.respond("gh", prListArgs, failure(`authentication failed for ${token}`));

    let message = "";
    try {
      await dogfoodRelease(operations, { version: "1.2.3", secretValues: [token] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(token);
    expect(JSON.stringify(operations.calls)).not.toContain(token);
    expect([...operations.writes.values()].join("\n")).not.toContain(token);
    expect(operations.logs.join("\n")).not.toContain(token);

    const loggedOperations = dogfoodOperations();
    loggedOperations.respond("gh", prListArgs, success("[]"), success("[]"));
    loggedOperations.respond(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        "chore: update dogfood SDK to 1.2.3",
        "--body-file",
        ".git/pipr-dogfood-pr.md",
      ],
      success(`https://example.test/pr/${token}`),
    );
    await dogfoodRelease(loggedOperations, { version: "1.2.3", secretValues: [token] });
    expect(loggedOperations.logs.join("\n")).toContain("[REDACTED]");
    expect(loggedOperations.logs.join("\n")).not.toContain(token);
  });
});

describe("release executable", () => {
  it("maps workflow-run environment and appends GitHub outputs", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "pipr-release-resolve-"));
    try {
      const outputPath = path.join(fixture, "github-output");
      await Bun.write(outputPath, "existing=value\n");

      const result = runReleaseScript("resolve", fixture, {
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: repository,
        PIPR_COMMIT_SUBJECT: "fix: ordinary change",
        PIPR_EVENT_NAME: "workflow_run",
        PIPR_WORKFLOW_RUN_SHA: releaseSha,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("not a Release Please merge commit");
      expect(await Bun.file(outputPath).text()).toBe("existing=value\npublish=false\n");
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("maps verify-tag files and emits the version output", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "pipr-release-verify-"));
    try {
      for (const manifestPath of [
        "package.json",
        "packages/sdk/package.json",
        "packages/runtime/package.json",
        "packages/cli/package.json",
      ]) {
        const file = path.join(fixture, manifestPath);
        await mkdir(path.dirname(file), { recursive: true });
        await Bun.write(file, packageJson("1.2.3"));
      }
      await Bun.write(
        path.join(fixture, "action.yml"),
        "name: Pipr Review\nruns:\n  using: docker\n  image: docker://ghcr.io/somus/pipr:v1.2.3\n",
      );
      const outputPath = path.join(fixture, "github-output");
      await Bun.write(outputPath, "");

      const result = runReleaseScript("verify-tag", fixture, {
        GITHUB_OUTPUT: outputPath,
        PIPR_RELEASE_TAG: "v1.2.3",
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(await Bun.file(outputPath).text()).toBe("version=1.2.3\n");
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("spawns argument-array commands and maps dogfood environment", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "pipr-release-dogfood-"));
    try {
      const binDir = path.join(fixture, "bin");
      const commandLog = path.join(fixture, "commands.log");
      await mkdir(binDir);
      const gitPath = path.join(binDir, "git");
      await Bun.write(
        gitPath,
        '#!/bin/sh\nprintf "argc=%s" "$#" >> "$COMMAND_LOG"\nfor argument in "$@"; do printf "|<%s>" "$argument" >> "$COMMAND_LOG"; done\nprintf "\\n" >> "$COMMAND_LOG"\n',
      );
      await chmod(gitPath, 0o755);
      await Bun.write(path.join(fixture, "package.json"), packageJson("1.2.4"));

      const result = runReleaseScript("dogfood", fixture, {
        COMMAND_LOG: commandLog,
        PATH: `${binDir}:${Bun.env.PATH ?? ""}`,
        PIPR_RELEASE_VERSION: "1.2.3",
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(await Bun.file(commandLog).text()).toBe(
        "argc=3|<fetch>|<origin>|<main>\nargc=4|<switch>|<-C>|<dogfood-sdk-1-2-3>|<origin/main>\n",
      );
      expect(result.stdout).toContain("Skipping dogfood SDK update because main is 1.2.4");
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("preserves a failing child process and stops subsequent operations", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "pipr-release-failure-"));
    try {
      const binDir = path.join(fixture, "bin");
      const commandLog = path.join(fixture, "commands.log");
      await mkdir(binDir);
      const gitPath = path.join(binDir, "git");
      await Bun.write(
        gitPath,
        '#!/bin/sh\nprintf "argc=%s" "$#" >> "$COMMAND_LOG"\nfor argument in "$@"; do printf "|<%s>" "$argument" >> "$COMMAND_LOG"; done\nprintf "\\n" >> "$COMMAND_LOG"\necho "git exploded" >&2\nexit 17\n',
      );
      await chmod(gitPath, 0o755);

      const result = runReleaseScript("dogfood", fixture, {
        COMMAND_LOG: commandLog,
        PATH: `${binDir}:${Bun.env.PATH ?? ""}`,
        PIPR_RELEASE_VERSION: "1.2.3",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("stderr: git exploded");
      expect(await Bun.file(commandLog).text()).toBe("argc=3|<fetch>|<origin>|<main>\n");
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
});

function runReleaseScript(
  command: string,
  cwd: string,
  env: Record<string, string>,
): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync(
    [process.execPath, path.join(repoRoot, "scripts/release.ts"), command],
    {
      cwd,
      env: { ...Bun.env, ...env },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}
