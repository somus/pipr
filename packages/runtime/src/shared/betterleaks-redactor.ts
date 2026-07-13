import { z } from "zod";
import {
  type SecretRedactionResult,
  type SecretRedactor,
  sensitiveEnvironmentValues,
} from "./secret-redactor.js";

const redactedSecret = "[redacted secret]";
const defaultBetterleaksExecutable = "/usr/local/bin/betterleaks";
const defaultBetterleaksConfig = "/opt/pipr/packages/runtime/betterleaks.toml";
const defaultTimeoutMs = 10_000;

const findingSchema = z.object({
  StartLine: z.number().int().positive(),
  EndLine: z.number().int().positive(),
  StartColumn: z.number().int().positive(),
  EndColumn: z.number().int().positive(),
});
const reportSchema = z.array(findingSchema);

type ScanResult = {
  exitCode: number;
  stdout: string;
};

type BetterleaksScan = (payload: string) => Promise<ScanResult>;

export function createBetterleaksSecretRedactor(options?: {
  executable?: string;
  configPath?: string;
  timeoutMs?: number;
  scan?: BetterleaksScan;
  env?: NodeJS.ProcessEnv;
}): SecretRedactor {
  const secrets = new Set<string>();
  for (const value of sensitiveEnvironmentValues(options?.env ?? process.env)) {
    secrets.add(value);
  }
  const scan =
    options?.scan ??
    ((payload) =>
      runBetterleaks(payload, {
        executable: options?.executable ?? defaultBetterleaksExecutable,
        configPath: options?.configPath ?? defaultBetterleaksConfig,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }));

  return {
    addSecret(value) {
      if (value && value.length >= 4) {
        secrets.add(value);
      }
    },
    async redact(values) {
      const exact = redactKnownSecrets(values, secrets);
      const framed = frameTargets(exact.map((result) => result.value));
      const scanResult = await scan(framed.payload);
      if (scanResult.exitCode !== 0 && scanResult.exitCode !== 1) {
        throw redactionFailure();
      }
      let findings: z.infer<typeof reportSchema>;
      try {
        findings = reportSchema.parse(JSON.parse(scanResult.stdout));
      } catch {
        throw redactionFailure();
      }
      const spans = spansByTarget(framed, findings);
      return exact.map((result, index) => {
        const scannerRedacted = applySpans(result.value, spans.get(index) ?? [], redactedSecret);
        return {
          value: scannerRedacted,
          detected: result.detected || scannerRedacted !== result.value,
        };
      });
    },
  };
}

function redactKnownSecrets(
  values: readonly string[],
  secrets: ReadonlySet<string>,
): SecretRedactionResult[] {
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return values.map((value) => {
    let next = value;
    for (const secret of ordered) {
      next = next.replaceAll(secret, redactedSecret);
    }
    return { value: next, detected: next !== value };
  });
}

type FramedTargets = {
  payload: string;
  targets: Array<{ start: number; end: number }>;
  lineStarts: number[];
};

function frameTargets(values: readonly string[]): FramedTargets {
  let payload = "";
  const targets: FramedTargets["targets"] = [];
  for (const [index, value] of values.entries()) {
    payload += `pipr-redaction-target-${index}-start\n`;
    const start = payload.length;
    payload += value;
    const end = payload.length;
    targets.push({ start, end });
    payload += `\npipr-redaction-target-${index}-end\n`;
  }
  return { payload, targets, lineStarts: lineStartsFor(payload) };
}

function lineStartsFor(value: string): number[] {
  const starts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function spansByTarget(
  framed: FramedTargets,
  findings: z.infer<typeof reportSchema>,
): Map<number, Array<{ start: number; end: number }>> {
  const result = new Map<number, Array<{ start: number; end: number }>>();
  for (const finding of findings) {
    const start = reportOffset(
      framed.payload,
      framed.lineStarts,
      finding.StartLine,
      finding.StartColumn,
      false,
    );
    const end = reportOffset(
      framed.payload,
      framed.lineStarts,
      finding.EndLine,
      finding.EndColumn,
      true,
    );
    const targetIndex = framed.targets.findIndex(
      (target) => start >= target.start && end <= target.end && start < end,
    );
    const target = framed.targets[targetIndex];
    if (targetIndex < 0 || !target) {
      throw redactionFailure();
    }
    const targetSpans = result.get(targetIndex) ?? [];
    targetSpans.push({ start: start - target.start, end: end - target.start });
    result.set(targetIndex, targetSpans);
  }
  return result;
}

function reportOffset(
  payload: string,
  lineStarts: readonly number[],
  line: number,
  column: number,
  inclusiveEnd: boolean,
): number {
  const lineStart = lineStarts[line - 1];
  if (lineStart === undefined) {
    throw redactionFailure();
  }
  const nextLineStart = lineStarts[line];
  const lineEnd = nextLineStart === undefined ? payload.length : nextLineStart - 1;
  // Betterleaks v1.6.1 reports UTF-8 byte columns and counts the newline byte
  // at the start of every line after the first.
  const normalizedColumn = column - (line > 1 ? 1 : 0);
  const byteOffset = inclusiveEnd ? normalizedColumn : normalizedColumn - 1;
  if (byteOffset < 0) {
    throw redactionFailure();
  }
  return lineStart + stringOffsetAtUtf8Byte(payload.slice(lineStart, lineEnd), byteOffset);
}

function stringOffsetAtUtf8Byte(value: string, byteOffset: number): number {
  if (byteOffset === 0) {
    return 0;
  }
  let bytes = 0;
  let stringOffset = 0;
  for (const character of value) {
    bytes += new TextEncoder().encode(character).length;
    stringOffset += character.length;
    if (bytes === byteOffset) {
      return stringOffset;
    }
    if (bytes > byteOffset) {
      break;
    }
  }
  throw redactionFailure();
}

function applySpans(
  value: string,
  spans: Array<{ start: number; end: number }>,
  replacement: string,
): string {
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans.sort((left, right) => left.start - right.start)) {
    const prior = merged.at(-1);
    if (prior && span.start <= prior.end) {
      prior.end = Math.max(prior.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  let next = value;
  for (const span of merged.reverse()) {
    next = `${next.slice(0, span.start)}${replacement}${next.slice(span.end)}`;
  }
  return next;
}

async function runBetterleaks(
  payload: string,
  options: { executable: string; configPath: string; timeoutMs: number },
): Promise<ScanResult> {
  try {
    const process = Bun.spawn(
      [
        options.executable,
        "stdin",
        "--no-banner",
        "--redact=100",
        "--report-format=json",
        "--report-path=-",
        "--max-decode-depth=0",
        "--max-archive-depth=0",
        `--config=${options.configPath}`,
      ],
      {
        cwd: "/opt/pipr",
        env: {
          HOME: "/home/bun",
          LANG: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    process.stdin.write(payload);
    await process.stdin.end();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, options.timeoutMs);
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    clearTimeout(timeout);
    if (timedOut) {
      throw redactionFailure();
    }
    return { exitCode, stdout };
  } catch {
    throw redactionFailure();
  }
}

function redactionFailure(): Error {
  return new Error("Secret redaction failed; publication aborted");
}
