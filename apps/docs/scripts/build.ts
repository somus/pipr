#!/usr/bin/env bun

import path from "node:path";
import { generateDocsOgImages } from "./og-images";

const fatalPrerenderMessages = [
  "Invalid hook call",
  "Error in renderToReadableStream",
  "Cannot read properties of null (reading 'useSyncExternalStore')",
];

export function docsBuildHasFatalPrerenderError(output: string): boolean {
  return fatalPrerenderMessages.some((message) => output.includes(message));
}

async function main(): Promise<void> {
  const docsDirectory = import.meta.dirname.replace(/\/scripts$/, "");
  const child = Bun.spawn(["bun", "run", "build:vite"], {
    cwd: docsDirectory,
    env: Bun.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  if (docsBuildHasFatalPrerenderError(`${stdout}\n${stderr}`)) {
    console.error("docs build failed because prerender logged a fatal React render error");
    process.exitCode = 1;
    return;
  }

  const images = await generateDocsOgImages({
    contentDirectory: path.join(docsDirectory, "content/docs"),
    outputDirectory: path.join(docsDirectory, ".output/public/og/docs"),
  });
  console.log(`Generated and verified ${images.length} documentation OG images.`);
}

if (import.meta.main) await main();
