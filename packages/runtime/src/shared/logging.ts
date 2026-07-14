import { sensitiveEnvironmentValues } from "./secret-redaction.js";

export type RuntimeLogSink = {
  log(record: RuntimeLogRecord): void;
  group<T>(name: string, run: () => Promise<T>): Promise<T>;
};

export type RuntimeLogRecord = {
  level: LogLevel;
  event: string;
  fields: RuntimeLogRecordFields;
  text?: string;
};

export type RuntimeLogFields = Record<
  string,
  string | number | boolean | readonly string[] | undefined
>;

export type RuntimeLogRecordFields = Record<string, string | number | boolean | readonly string[]>;

export type RuntimeLog = {
  info(event: string, fields?: RuntimeLogFields): void;
  notice(event: string, fields?: RuntimeLogFields): void;
  warning(event: string, fields?: RuntimeLogFields): void;
  error(event: string, fields?: RuntimeLogFields): void;
  debug(event: string, fields?: RuntimeLogFields): void;
  text(level: LogLevel, event: string, text: string): void;
  textSnippet(
    level: LogLevel,
    event: string,
    text: string,
    options?: { maxBytes?: number; maxLines?: number },
  ): void;
  formatTextSnippet(text: string, options?: { maxBytes?: number; maxLines?: number }): string;
  group<T>(name: string, run: () => Promise<T>): Promise<T>;
  addSecret(value: string | undefined): void;
  debugEnabled: boolean;
  writesToSink: boolean;
};

export type LogLevel = "info" | "notice" | "warning" | "error" | "debug";

export function createRuntimeLog(options: {
  logSink?: RuntimeLogSink;
  env?: NodeJS.ProcessEnv;
}): RuntimeLog {
  const secrets = new Set<string>();
  for (const value of sensitiveEnvironmentValues(options.env ?? process.env)) {
    addSecret(secrets, value);
  }
  const debugEnabled =
    (options.env ?? process.env).ACTIONS_STEP_DEBUG === "true" ||
    (options.env ?? process.env).PIPR_LOG_LEVEL === "debug";
  const sink = options.logSink ?? noopRuntimeLogSink;

  return {
    debugEnabled,
    writesToSink: options.logSink !== undefined,
    info(event, fields) {
      emitRecord(sink, secrets, "info", event, fields);
    },
    notice(event, fields) {
      emitRecord(sink, secrets, "notice", event, fields);
    },
    warning(event, fields) {
      emitRecord(sink, secrets, "warning", event, fields);
    },
    error(event, fields) {
      emitRecord(sink, secrets, "error", event, fields);
    },
    debug(event, fields) {
      if (debugEnabled) {
        emitRecord(sink, secrets, "debug", event, fields);
      }
    },
    text(level, event, text) {
      if (level === "debug" && !debugEnabled) {
        return;
      }
      emitRecord(sink, secrets, level, event, undefined, redact(text, secrets));
    },
    textSnippet(level, event, text, snippetOptions) {
      if (level === "debug" && !debugEnabled) {
        return;
      }
      emitRecord(
        sink,
        secrets,
        level,
        event,
        undefined,
        formatTextSnippet(text, secrets, snippetOptions),
      );
    },
    formatTextSnippet(text, snippetOptions) {
      return formatTextSnippet(text, secrets, snippetOptions);
    },
    async group(name, run) {
      return await sink.group(redact(name, secrets), run);
    },
    addSecret(value) {
      addSecret(secrets, value);
    },
  };
}

export function shortSha(sha: string | undefined): string | undefined {
  return sha?.slice(0, 12);
}

export function boundedLogSnippet(
  text: string,
  options?: { maxBytes?: number; maxLines?: number },
): string {
  const maxBytes = options?.maxBytes ?? 8192;
  const maxLines = options?.maxLines ?? 20;
  const lines = text.split(/\r?\n/);
  const selected =
    lines.length <= maxLines * 2
      ? lines
      : [...lines.slice(0, maxLines), "...", ...lines.slice(-maxLines)];
  const prefixed = selected
    .map((line) => `| ${line}`)
    .join("\n")
    .slice(0, maxBytes);
  return prefixed || "| <empty>";
}

function addSecret(secrets: Set<string>, value: string | undefined): void {
  if (value && value.length >= 4) {
    secrets.add(value);
  }
}

function redact(message: string, secrets: Set<string>): string {
  let redacted = message;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}

function compactFields(
  fields: RuntimeLogFields | undefined,
  secrets: Set<string>,
): RuntimeLogRecordFields {
  const compact: RuntimeLogRecordFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string") {
      compact[key] = redact(value, secrets);
    } else if (Array.isArray(value)) {
      compact[key] = value.map((item) => redact(item, secrets));
    } else if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}

function formatTextSnippet(
  text: string,
  secrets: Set<string>,
  options?: { maxBytes?: number; maxLines?: number },
): string {
  return boundedLogSnippet(redact(text, secrets), options);
}

function emitRecord(
  sink: RuntimeLogSink,
  secrets: Set<string>,
  level: LogLevel,
  event: string,
  fields?: RuntimeLogFields,
  text?: string,
): void {
  sink.log({
    level,
    event: redact(event, secrets),
    fields: compactFields(fields, secrets),
    text,
  });
}

const noopRuntimeLogSink: RuntimeLogSink = {
  log() {},
  async group(_name, run) {
    return await run();
  },
};
