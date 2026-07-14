export type SecretRedactionResult = {
  value: string;
  detected: boolean;
};

export type SecretRedactor = {
  addSecret(value: string | undefined): void;
  redact(value: string): SecretRedactionResult;
};

const sensitiveEnvNamePattern =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|COOKIE)(?:_|$)/i;

export function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && sensitiveEnvNamePattern.test(name) ? [value] : [],
  );
}
