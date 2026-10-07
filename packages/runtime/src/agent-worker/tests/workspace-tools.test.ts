import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWorkspaceToolNames } from "../protocol.js";
import { createWorkspaceTools } from "../workspace-tools.js";

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-workspace-tools-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "pipr-workspace-outside-"));
  await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
  await mkdir(path.join(workspace, ".git"));
  await writeFile(
    path.join(workspace, "src", "app.ts"),
    "export const answer = 42;\nexport const name = 'pipr';\n",
  );
  await writeFile(
    path.join(workspace, "src", "nested", "util.ts"),
    "export function helper() {}\n",
  );
  await writeFile(path.join(workspace, ".git", "config"), "secret = true\n");
  await writeFile(path.join(outside, "secret.txt"), "outside secret\n");
  await symlink(outside, path.join(workspace, "linked"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = createWorkspaceTools(agentWorkspaceToolNames, workspace).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`missing tool ${name}`);
  expect(tool.replay).toBe("safe");
  const result = await tool.execute(
    args as never,
    { callId: "call-1" } as never,
    BACKGROUND_CONTEXT,
  );
  return (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
}

describe("workspace tools", () => {
  it("reads files with offsets and continuation hints", async () => {
    expect(await call("read", { path: "src/app.ts" })).toBe(
      "export const answer = 42;\nexport const name = 'pipr';\n",
    );
    expect(await call("read", { path: "src/app.ts", offset: 2, limit: 1 })).toBe(
      "export const name = 'pipr';\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]",
    );
  });

  it("searches contents and paths without entering .git", async () => {
    expect(await call("grep", { pattern: "answer|helper" })).toBe(
      [
        "src/app.ts:1:export const answer = 42;",
        "src/nested/util.ts:1:export function helper() {}",
      ].join("\n"),
    );
    expect(await call("grep", { pattern: "secret" })).toBe("No matches found");
    expect(await call("find", { pattern: "**/*.ts" })).toBe("src/app.ts\nsrc/nested/util.ts");
    expect(await call("ls", {})).toBe("linked\nsrc/");
    expect(await call("ls", { path: "src" })).toBe("app.ts\nnested/");
  });

  it("caps result lists", async () => {
    expect(await call("find", { pattern: "**/*.ts", limit: 1 })).toBe(
      "src/app.ts\n\n[Showing 1 of 2 lines. Narrow the search to see more.]",
    );
  });

  it("rejects paths outside the workspace, through symlinks, or into .git", async () => {
    await expect(call("read", { path: "../secret.txt" })).rejects.toThrow("Unsafe manifest path");
    await expect(call("read", { path: path.join(outside, "secret.txt") })).rejects.toThrow(
      "Unsafe manifest path",
    );
    await expect(call("read", { path: "linked/secret.txt" })).rejects.toThrow("crosses a symlink");
    await expect(call("read", { path: ".git/config" })).rejects.toThrow("Unsafe manifest path");
    await expect(call("grep", { pattern: "secret", path: "linked" })).rejects.toThrow(
      "crosses a symlink",
    );
    await expect(call("ls", { path: "linked" })).rejects.toThrow("crosses a symlink");
  });
});
