import {
  codeHostErrorStatus,
  errorHeaders,
  isTransientCodeHostError,
  retryAfterMilliseconds,
} from "./retry-policy.js";

type Sleep = (milliseconds: number) => Promise<void>;

export type CodeHostRetryOptions<T> = {
  operation(): Promise<T>;
  reconcile?: () => Promise<T | undefined>;
  idempotent?: boolean;
  retryStatuses?: readonly number[];
  sleep?: Sleep;
  now?: () => number;
  maxAttempts?: number;
  maxRetryDelayMilliseconds?: number;
  maxTotalRetryDelayMilliseconds?: number;
};

export async function retryCodeHostOperation<T>(options: CodeHostRetryOptions<T>): Promise<T> {
  const policy = normalizeRetryPolicy(options);
  let totalRetryDelay = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await options.operation();
    } catch (error) {
      if (!shouldRetry(error, attempt, policy.maxAttempts, options)) throw error;
      const reconciled = await reconcile(options.reconcile);
      if (reconciled.found) return reconciled.value as T;

      const retryDelay = retryDelayMilliseconds(error, attempt, policy.now());
      if (!isDelayAllowed(retryDelay, totalRetryDelay, policy)) throw error;
      totalRetryDelay += retryDelay;
      await policy.sleep(retryDelay);
    }
  }
}

type RetryPolicy = {
  sleep: Sleep;
  now: () => number;
  maxAttempts: number;
  maxRetryDelayMilliseconds: number;
  maxTotalRetryDelayMilliseconds: number;
};

function normalizeRetryPolicy<T>(options: CodeHostRetryOptions<T>): RetryPolicy {
  return {
    sleep: options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds)),
    now: options.now ?? Date.now,
    maxAttempts: options.maxAttempts ?? 3,
    maxRetryDelayMilliseconds: options.maxRetryDelayMilliseconds ?? 60_000,
    maxTotalRetryDelayMilliseconds: options.maxTotalRetryDelayMilliseconds ?? 120_000,
  };
}

async function reconcile<T>(
  operation: (() => Promise<T | undefined>) | undefined,
): Promise<{ found: boolean; value?: T }> {
  if (!operation) return { found: false };
  const value = await operation();
  return value === undefined ? { found: false } : { found: true, value };
}

function shouldRetry<T>(
  error: unknown,
  attempt: number,
  maxAttempts: number,
  options: CodeHostRetryOptions<T>,
): boolean {
  if (attempt >= maxAttempts) return false;
  const status = codeHostErrorStatus(error);
  if (status === undefined) return false;
  const explicitlyRetryable = options.retryStatuses?.includes(status) === true;
  const retrySafe = explicitlyRetryable || options.idempotent === true || !!options.reconcile;
  return retrySafe && (explicitlyRetryable || isTransientCodeHostError(status, error));
}

function retryDelayMilliseconds(error: unknown, attempt: number, now: number): number {
  return retryAfterMilliseconds(errorHeaders(error), now) ?? 250 * 2 ** (attempt - 1);
}

function isDelayAllowed(retryDelay: number, totalRetryDelay: number, policy: RetryPolicy): boolean {
  return (
    retryDelay <= policy.maxRetryDelayMilliseconds &&
    totalRetryDelay + retryDelay <= policy.maxTotalRetryDelayMilliseconds
  );
}
