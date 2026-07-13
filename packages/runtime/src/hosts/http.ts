import type { z } from "zod";
import { retryAfterMilliseconds, retryCodeHostOperation } from "./retry.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CodeHostHttpClientOptions = {
  baseUrl: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
  maxRetryDelayMilliseconds?: number;
  maxTotalRetryDelayMilliseconds?: number;
  now?: () => number;
  requestTimeoutMilliseconds?: number;
  retryNonIdempotentStatuses?: readonly number[];
};

export class CodeHostHttpError extends Error {
  readonly status: number;
  readonly headers: Headers;

  constructor(message: string, status: number, headers: Headers = new Headers()) {
    super(message);
    this.name = "CodeHostHttpError";
    this.status = status;
    this.headers = headers;
  }
}

export function createCodeHostHttpClient(options: CodeHostHttpClientOptions) {
  const fetchRequest = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? 2;
  const requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 30_000;
  const secrets = [...new Headers(options.headers).values()].flatMap((value) =>
    [value, value.split(/\s+/).at(-1)].filter(
      (candidate): candidate is string => candidate !== undefined && candidate.length >= 8,
    ),
  );
  let delayBeforeNextRequest = 0;

  return {
    async json<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
      if (delayBeforeNextRequest > 0) {
        await sleep(delayBeforeNextRequest);
        delayBeforeNextRequest = 0;
      }

      const method = init.method?.toUpperCase() ?? "GET";
      return await retryCodeHostOperation({
        idempotent: method === "GET" || method === "HEAD",
        retryStatuses: options.retryNonIdempotentStatuses,
        maxAttempts: maxRetries + 1,
        maxRetryDelayMilliseconds: options.maxRetryDelayMilliseconds,
        maxTotalRetryDelayMilliseconds: options.maxTotalRetryDelayMilliseconds,
        now,
        sleep,
        operation: async () => {
          const timeoutSignal = AbortSignal.timeout(requestTimeoutMilliseconds);
          const response = await fetchRequest(new URL(path, options.baseUrl), {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(options.headers)),
              ...Object.fromEntries(new Headers(init.headers)),
            },
            signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
          });
          if (response.ok) {
            delayBeforeNextRequest = retryAfterMilliseconds(response.headers, now()) ?? 0;
            return schema.parse(await response.json());
          }
          const body = (await response.text()).slice(0, 1_024);
          throw new CodeHostHttpError(
            redact(
              `Code host request failed (${response.status} ${response.statusText}): ${body}`,
              secrets,
            ),
            response.status,
            response.headers,
          );
        },
      });
    },
  };
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}
