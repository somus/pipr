import type { SecretRedactor } from "./secret-redaction.js";

const redactedSecret = "[redacted secret]";
const minimumSecretLength = 4;

export function createSecretRedactor(initialSecrets: readonly string[]): SecretRedactor {
  const secrets = new Set(initialSecrets.filter((value) => value.length >= minimumSecretLength));
  return {
    addSecret(value) {
      if (value && value.length >= minimumSecretLength) {
        secrets.add(value);
      }
    },
    redact(value) {
      const ordered = [...secrets].sort((left, right) => right.length - left.length);
      let next = value;
      for (const secret of ordered) {
        next = next.replaceAll(secret, redactedSecret);
      }
      return { value: next, detected: next !== value };
    },
  };
}
