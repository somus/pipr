import { describe, expect, it } from "bun:test";
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
}

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
    expect(operations.sleeps).toEqual([7]);
    expect(operations.outputs).toEqual([]);
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

  it("propagates PR lookup and push failures", async () => {
    const lookupOperations = dogfoodOperations();
    lookupOperations.respond("gh", prListArgs, failure("GitHub unavailable"));
    await expect(dogfoodRelease(lookupOperations, { version: "1.2.3" })).rejects.toThrow(
      "GitHub unavailable",
    );

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

  it("stages only the release metadata paths and force-with-lease pushes the deterministic branch", async () => {
    const operations = dogfoodOperations();

    await dogfoodRelease(operations, { version: "1.2.3" });

    expect(operations.calls).toContainEqual({
      command: "git",
      args: ["add", ...dogfoodPaths],
      options: undefined,
    });
    expect(operations.calls).toContainEqual({
      command: "git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--force-with-lease",
        "origin",
        `HEAD:${branch}`,
      ],
      options: undefined,
    });
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
  });
});
