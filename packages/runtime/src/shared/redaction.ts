const secretLikeTokenPattern =
  /\b[A-Za-z0-9][A-Za-z0-9_.:/+=-]*(?:secret|token|api[_-]?key|apikey)[A-Za-z0-9_.:/+=-]{8,}\b/gi;

export function redactPotentialSecrets(value: string): string {
  return value.replace(secretLikeTokenPattern, "[redacted secret]");
}
