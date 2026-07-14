import { sensitiveEnvironmentValues } from "./secret-redaction.js";
import { createSecretRedactor } from "./secret-redactor-core.js";

export function createKnownSecretRedactor(options?: { env?: NodeJS.ProcessEnv }) {
  return createSecretRedactor(sensitiveEnvironmentValues(options?.env ?? process.env));
}
