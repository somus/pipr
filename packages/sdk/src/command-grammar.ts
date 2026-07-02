export function commandPatternParts(pattern: string): string[] {
  return pattern.match(/\[[^\]]+\]|[^\s]+/g) ?? [];
}

export function tokenizeCommandPattern(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function unsupportedCommandRestCaptureError(pattern: string): string | undefined {
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

export function isOptionalCommandPatternPart(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

export function isCommandCaptureToken(value: string): boolean {
  return /^<[a-z0-9-]+(\.\.\.)?>$/.test(value);
}

export function isCommandRestCaptureToken(value: string): boolean {
  return /^<[a-z0-9-]+\.\.\.>$/.test(value);
}

function finalRequiredRestCaptureMessage(token: string): string {
  return `Rest capture '${token}' must be the final required command pattern token`;
}
