import type { z } from "zod";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CodeHostHttpClientOptions = {
  baseUrl: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
  requestTimeoutMilliseconds?: number;
  retryNonIdempotentStatuses?: readonly number[];
};

export class CodeHostHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CodeHostHttpError";
    this.status = status;
  }
}

export function createCodeHostHttpClient(options: CodeHostHttpClientOptions) {
  const fetchRequest = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
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
      for (let attempt = 0; ; attempt += 1) {
        const timeoutSignal = AbortSignal.timeout(requestTimeoutMilliseconds);
        const response = await fetchRequest(new URL(path, options.baseUrl), {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(options.headers)),
            ...Object.fromEntries(new Headers(init.headers)),
          },
          signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
        });
        const retryAfter = retryAfterMilliseconds(response.headers.get("Retry-After"));
        if (response.ok) {
          delayBeforeNextRequest = retryAfter;
          return schema.parse(await response.json());
        }
        if (
          shouldRetryCodeHostRequest({
            method,
            attempt,
            maxRetries,
            response,
            retryStatuses: options.retryNonIdempotentStatuses,
          })
        ) {
          await sleep(retryAfter || 250 * 2 ** attempt);
          continue;
        }
        const body = (await response.text()).slice(0, 1_024);
        throw new CodeHostHttpError(
          redact(
            `Code host request failed (${response.status} ${response.statusText}): ${body}`,
            secrets,
          ),
          response.status,
        );
      }
    },
  };
}

function shouldRetryCodeHostRequest(options: {
  method: string;
  attempt: number;
  maxRetries: number;
  response: Response;
  retryStatuses?: readonly number[];
}): boolean {
  return (
    (options.method === "GET" ||
      options.method === "HEAD" ||
      options.retryStatuses?.includes(options.response.status) === true) &&
    options.attempt < options.maxRetries &&
    (options.response.status === 429 ||
      options.response.status >= 500 ||
      options.retryStatuses?.includes(options.response.status) === true)
  );
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}
