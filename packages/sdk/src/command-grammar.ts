/**
 * The `@pipr` command pattern grammar: registration-time validation for
 * `pipr.command` and parse-time matching for the runtime command dispatcher.
 */

type CommandPatternParseResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

function commandPatternParts(pattern: string): string[] {
  return pattern.match(/\[[^\]]+\]|[^\s]+/g) ?? [];
}

export function tokenizeCommandPattern(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function unsupportedCommandRestCaptureError(pattern: string): string | undefined {
  const parts = commandPatternParts(pattern);
  for (const [index, part] of parts.entries()) {
    if (isOptionalCommandPatternPart(part)) {
      const optionalRest = tokenizeCommandPattern(part.slice(1, -1)).find(
        isCommandRestCaptureToken,
      );
      if (optionalRest) {
        return finalRequiredRestCaptureMessage(optionalRest);
      }
      continue;
    }
    if (isCommandRestCaptureToken(part) && index !== parts.length - 1) {
      return finalRequiredRestCaptureMessage(part);
    }
  }
  return undefined;
}

export function assertSupportedCommandRestCapture(pattern: string): void {
  const error = unsupportedCommandRestCaptureError(pattern);
  if (error) {
    throw new Error(error);
  }
}

function isOptionalCommandPatternPart(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

function isCommandCaptureToken(value: string): boolean {
  return /^<[a-z0-9-]+(\.\.\.)?>$/.test(value);
}

function isCommandRestCaptureToken(value: string): boolean {
  return /^<[a-z0-9-]+\.\.\.>$/.test(value);
}

function finalRequiredRestCaptureMessage(token: string): string {
  return `Rest capture '${token}' must be the final required command pattern token`;
}

export function parseCommandPattern(pattern: string, line: string): CommandPatternParseResult {
  const patternParts = commandPatternParts(pattern);
  const validationError = unsupportedCommandRestCaptureError(pattern);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  const lineTokens = tokenizeCommandPattern(line);
  const captures: Record<string, string> = {};
  let index = 0;
  for (const part of patternParts) {
    if (isOptionalCommandPatternPart(part)) {
      const nextIndex = parseOptionalPatternPart(part.slice(1, -1), lineTokens, index, captures);
      if (nextIndex !== undefined) {
        index = nextIndex;
      }
      continue;
    }
    if (isCommandRestCaptureToken(part)) {
      const value = lineTokens.slice(index).join(" ");
      if (!value) {
        return { ok: false, error: `Expected '${part}'` };
      }
      captures[part.slice(1, -4)] = value;
      index = lineTokens.length;
      continue;
    }
    const nextIndex = parsePatternToken(part, lineTokens, index, captures);
    if (nextIndex === undefined) {
      return { ok: false, error: `Expected '${part}'` };
    }
    index = nextIndex;
  }
  if (index !== lineTokens.length) {
    return { ok: false, error: `Unexpected argument '${lineTokens[index]}'` };
  }
  return { ok: true, value: captures };
}

export function commandPatternPrefixMatches(pattern: string, line: string): boolean {
  const patternTokens = commandPatternParts(pattern);
  if (unsupportedCommandRestCaptureError(pattern)) {
    return false;
  }
  const lineTokens = tokenizeCommandPattern(line);
  let index = 0;
  for (const token of patternTokens) {
    if (isCommandCaptureToken(token) || isOptionalCommandPatternPart(token)) {
      return true;
    }
    if (lineTokens[index] !== token) {
      return false;
    }
    index += 1;
  }
  return true;
}

function parseOptionalPatternPart(
  pattern: string,
  lineTokens: string[],
  startIndex: number,
  captures: Record<string, string>,
): number | undefined {
  const patternTokens = tokenizeCommandPattern(pattern);
  if (patternTokens.length === 0 || lineTokens[startIndex] !== patternTokens[0]) {
    return undefined;
  }
  const snapshot = { ...captures };
  let index = startIndex;
  for (const token of patternTokens) {
    const nextIndex = parsePatternToken(token, lineTokens, index, captures);
    if (nextIndex === undefined) {
      for (const key of Object.keys(captures)) {
        delete captures[key];
      }
      Object.assign(captures, snapshot);
      return undefined;
    }
    index = nextIndex;
  }
  return index;
}

function parsePatternToken(
  patternToken: string,
  lineTokens: string[],
  index: number,
  captures: Record<string, string>,
): number | undefined {
  if (isCommandCaptureToken(patternToken)) {
    const value = lineTokens[index];
    if (!value) {
      return undefined;
    }
    captures[patternToken.slice(1, -1)] = value;
    return index + 1;
  }
  return lineTokens[index] === patternToken ? index + 1 : undefined;
}
