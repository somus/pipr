export function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }],
    details: (value ?? null) as never,
  };
}

export function serializedToolResponseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertSerializedToolResponseFits<T>(
  value: T,
  maxBytes: number,
  errorMessage: string,
): T {
  if (serializedToolResponseBytes(value) > maxBytes) {
    throw new Error(errorMessage);
  }
  return value;
}

export function boundToolResponseContent<T extends { content: string }>(
  value: T,
  maxBytes: number,
  errorMessage: string,
): T & { truncated: boolean } {
  if (serializedToolResponseBytes(value) <= maxBytes) {
    return value as T & { truncated: boolean };
  }
  const empty = { ...value, content: "", truncated: true };
  assertSerializedToolResponseFits(empty, maxBytes, errorMessage);
  const originalBuffer = Buffer.from(value.content, "utf8");
  let low = 0;
  let high = originalBuffer.byteLength;
  let best = empty;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...value,
      content: originalBuffer.subarray(0, middle).toString("utf8"),
      truncated: true,
    };
    if (serializedToolResponseBytes(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
