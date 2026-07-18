#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { releaseTargets } from "../packages/cli/src/release/targets.js";

const releaseDir = path.resolve(process.argv[2] ?? "dist/release");
const expectedAssets = [...releaseTargets.map((target) => target.outfile), "SHA256SUMS"].sort();
const actualAssets = (await readdir(releaseDir)).sort();

if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
  throw new Error(
    `release artifacts must exactly match ${expectedAssets.join(", ")}; found ${actualAssets.join(", ")}`,
  );
}

const checksumLines = (await Bun.file(path.join(releaseDir, "SHA256SUMS")).text())
  .trim()
  .split("\n")
  .sort();
const expectedChecksumLines = await Promise.all(
  releaseTargets.map(async ({ outfile }) => {
    const contents = await Bun.file(path.join(releaseDir, outfile)).arrayBuffer();
    const digest = createHash("sha256").update(Buffer.from(contents)).digest("hex");
    return `${digest}  ${outfile}`;
  }),
);
expectedChecksumLines.sort();

if (JSON.stringify(checksumLines) !== JSON.stringify(expectedChecksumLines)) {
  throw new Error("SHA256SUMS does not exactly match the release binaries");
}

console.log(`verified ${releaseTargets.length} release binaries and SHA256SUMS`);
