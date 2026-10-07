export { commandPatternPrefixMatches, parseCommandPattern } from "@usepipr/sdk/internal";

const piprCommandPrefix = "@pipr";

export function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

export function isPiprCommandLine(line: string): boolean {
  return line === piprCommandPrefix || line.startsWith(`${piprCommandPrefix} `);
}
