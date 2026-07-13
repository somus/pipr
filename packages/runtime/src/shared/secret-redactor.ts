export type SecretRedactionResult = {
  value: string;
  detected: boolean;
};

export type SecretRedactor = {
  addSecret(value: string | undefined): void;
  redact(value: string): SecretRedactionResult;
};

const redactedSecret = "[redacted secret]";
const minimumSecretLength = 4;
const sensitiveEnvNamePattern = /(TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|COOKIE)/i;

export function createKnownSecretRedactor(options?: { env?: NodeJS.ProcessEnv }): SecretRedactor {
  const secrets = new Set(
    sensitiveEnvironmentValues(options?.env ?? process.env).filter(
      (value) => value.length >= minimumSecretLength,
    ),
  );
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

export function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && sensitiveEnvNamePattern.test(name) ? [value] : [],
  );
}
