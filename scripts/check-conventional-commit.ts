#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const generatedMessagePatterns = [/^Merge\b/, /^Revert\b/, /^fixup! /, /^squash! /];

const args = process.argv.slice(2);

if (args.length === 0) {
  usage();
}

if (args[0] === "--message") {
  const message = args.slice(1).join(" ");
  if (!message) {
    throw new Error("--message requires a value");
  }
  await checkTemporaryMessage(message, checkGeneratedOrConventionalFile);
} else if (args[0] === "--title") {
  const title = args.slice(1).join(" ");
  if (!title) {
    throw new Error("--title requires a value");
  }
  await checkTemporaryMessage(title, runConventionalCommitCheck);
} else if (args[0] === "--range") {
  const range = args[1];
  if (!range) {
    throw new Error("--range requires a git revision range");
  }
  await checkRange(range);
} else {
  const filePath = args[0];
  if (!filePath) {
    usage();
  }
  await checkGeneratedOrConventionalFile(filePath);
}

async function checkRange(range: string): Promise<void> {
  const result = Bun.spawnSync(["git", "log", "--format=%s", range], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git log failed for ${range}`);
  }

  const subjects = result.stdout.toString().split("\n").filter(Boolean);
  for (const subject of subjects) {
    await checkTemporaryMessage(subject, checkGeneratedOrConventionalFile);
  }
}

async function checkTemporaryMessage(
  message: string,
  check: (filePath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipr-commit-msg-"));
  const filePath = path.join(tempDir, "COMMIT_EDITMSG");
  try {
    await writeFile(filePath, `${message.trim()}\n`);
    await check(filePath);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function checkGeneratedOrConventionalFile(filePath: string): Promise<void> {
  const message = await Bun.file(filePath).text();
  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (generatedMessagePatterns.some((pattern) => pattern.test(subject))) {
    return;
  }
  await runConventionalCommitCheck(filePath);
}

async function runConventionalCommitCheck(filePath: string): Promise<void> {
  const result = Bun.spawnSync(["hk", "util", "check-conventional-commit", filePath], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function usage(): never {
  throw new Error(
    "usage: check-conventional-commit.ts <commit-msg-file> | --message <subject> | --title <title> | --range <base..head>",
  );
}
