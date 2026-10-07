export type SecretRedactionResult = {
  value: string;
  detected: boolean;
};

export type SecretRedactor = {
  addSecret(value: string | undefined): void;
  redact(value: string): SecretRedactionResult;
};

// TOKEN, SECRET, and PASSWORD also match as word suffixes (SYSTEM_ACCESSTOKEN);
// shorter markers stay whole segments so TURKEY or AUTHOR do not match.
const credentialEnvNamePattern =
  /(?:^|_)(?:[A-Z0-9]*(?:TOKEN|SECRET|PASSWORD)|AUTH|CREDENTIAL|COOKIE)(?:_|$)/i;
const keyEnvNamePattern = /(?:^|_)KEY(?:_|$)/i;
// A KEY naming a record rather than a credential, such as BITBUCKET_EVENT_KEY or GIT_CONFIG_KEY_0.
const identifierKeyEnvNamePattern =
  /(?:^|_)(?:EVENT|PROJECT|CONFIG|ISSUE|REPO|REPOSITORY|WORKSPACE|CACHE|PARTITION|SORT)_KEY(?:_|$)/i;

function isSensitiveEnvName(name: string): boolean {
  return (
    credentialEnvNamePattern.test(name) ||
    (keyEnvNamePattern.test(name) && !identifierKeyEnvNamePattern.test(name))
  );
}

export function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && isSensitiveEnvName(name) ? [value] : [],
  );
}
