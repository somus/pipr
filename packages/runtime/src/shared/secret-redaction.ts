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
const sensitiveEnvNamePattern =
  /(?:^|_)(?:[A-Z0-9]*(?:TOKEN|SECRET|PASSWORD)|KEY|AUTH|CREDENTIAL|COOKIE)(?:_|$)/i;

export function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && sensitiveEnvNamePattern.test(name) ? [value] : [],
  );
}
