#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPiprEffectivenessBenchmark, writePiprEffectivenessReport } from "./effectiveness.js";
import {
  effectivenessBenchmarkCases,
  effectivenessBenchmarkVariants,
} from "./effectiveness-cases.js";
import { assertLiveEvalEnv } from "./live-prompt-gates.js";

interface BenchmarkOptions {
  repetitions: number;
  caseIds?: Set<string>;
  outputPath?: string;
}

const optionParsers: Record<string, (value: string, options: BenchmarkOptions) => void> = {
  "--repetitions": (value, options) => {
    options.repetitions = parseRepetitions(value);
  },
  "--cases": (value, options) => {
    options.caseIds = parseCaseIds(value);
  },
  "--output": (value, options) => {
    options.outputPath = value;
  },
};

function parseOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { repetitions: 3 };
  for (let index = 0; index < args.length; index += 2) {
    parseOption(args[index], args[index + 1], options);
  }
  return options;
}

function parseOption(
  flag: string | undefined,
  value: string | undefined,
  options: BenchmarkOptions,
): void {
  const requiredFlag = requireOptionPart(flag, "");
  const requiredValue = requireOptionPart(value, requiredFlag);
  const parse = optionParsers[requiredFlag];
  if (!parse) {
    throw new Error(`unknown or incomplete effectiveness benchmark option: ${requiredFlag}`);
  }
  parse(requiredValue, options);
}

function requireOptionPart(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`unknown or incomplete effectiveness benchmark option: ${flag}`);
  }
  return value;
}

function parseRepetitions(value: string): number {
  const repetitions = Number(value);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("--repetitions must be an integer from 1 to 10");
  }
  return repetitions;
}

function parseCaseIds(value: string): Set<string> {
  const caseIds = new Set(value.split(",").filter(Boolean));
  if (caseIds.size === 0) {
    throw new Error("--cases must include at least one case id");
  }
  return caseIds;
}

assertLiveEvalEnv();

const options = parseOptions(process.argv.slice(2));
const generatedAt = new Date().toISOString();
const selectedCases = options.caseIds
  ? effectivenessBenchmarkCases.filter(({ id }) => options.caseIds?.has(id))
  : effectivenessBenchmarkCases;
if (options.caseIds && selectedCases.length !== options.caseIds.size) {
  throw new Error("effectiveness benchmark case selection includes an unknown id");
}

const report = await runPiprEffectivenessBenchmark({
  cases: selectedCases,
  variants: effectivenessBenchmarkVariants,
  repetitions: options.repetitions,
  metadata: {
    generatedAt,
    sourceDirty:
      execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        encoding: "utf8",
      }).trim().length > 0,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  },
});

const outputPath = options.outputPath ?? defaultOutputPath(generatedAt);
await writePiprEffectivenessReport(report, outputPath);
console.log(JSON.stringify(report, null, 2));
console.error(`effectiveness report written to ${outputPath}`);

function defaultOutputPath(generatedAt: string): string {
  const fileName = `${generatedAt.replaceAll(":", "-")}.json`;
  return fileURLToPath(new URL(`../evalite-export/effectiveness/${fileName}`, import.meta.url));
}
