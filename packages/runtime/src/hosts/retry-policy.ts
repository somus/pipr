const transientStatuses = new Set([429, 500, 502, 503, 504]);

export function isTransientCodeHostError(status: number, error: unknown): boolean {
  return (
    transientStatuses.has(status) ||
    (status === 403 && retryAfterMilliseconds(errorHeaders(error)) !== undefined)
  );
}

export function codeHostErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = Reflect.get(error, "status");
  if (typeof direct === "number") return direct;
  const response = Reflect.get(error, "response");
  if (!response || typeof response !== "object") return undefined;
  const nested = Reflect.get(response, "status");
  return typeof nested === "number" ? nested : undefined;
}

export function retryAfterMilliseconds(headers: unknown, now = Date.now()): number | undefined {
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  if (headerValue(headers, "x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(headerValue(headers, "x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
      return Math.max(0, resetSeconds * 1_000 - now);
    }
  }
  return undefined;
}

export function errorHeaders(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const direct = Reflect.get(error, "headers");
  if (direct !== undefined) return direct;
  const response = Reflect.get(error, "response");
  return response && typeof response === "object" ? Reflect.get(response, "headers") : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (!headers || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}
