export type SecretRedactionResult = {
  value: string;
  detected: boolean;
};

export type SecretRedactor = {
  addSecret(value: string | undefined): void;
  redact(values: readonly string[]): Promise<readonly SecretRedactionResult[]>;
};

const sensitiveEnvNamePattern = /(TOKEN|SECRET|PASSWORD|PASS|KEY|AUTH|CREDENTIAL|COOKIE)/i;

export function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && sensitiveEnvNamePattern.test(name) ? [value] : [],
  );
}
