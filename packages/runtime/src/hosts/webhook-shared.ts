import { createHmac, timingSafeEqual } from "node:crypto";

export function parseWebhookJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function webhookSecretsEqual(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

/** Constant-time comparison of a hex-encoded HMAC-SHA256 signature over `payload`. */
export function hmacSha256HexMatches(payload: string, hexSignature: string, secret: string) {
  const supplied = Buffer.from(hexSignature, "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
