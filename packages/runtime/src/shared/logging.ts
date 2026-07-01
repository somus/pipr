import pino from "pino";

export type ActionLogSink = {
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  group<T>(name: string, run: () => Promise<T>): Promise<T>;
};

export type ActionLogFields = Record<
  string,
  string | number | boolean | readonly string[] | undefined
>;

export type RuntimeActionLog = {
  info(event: string, fields?: ActionLogFields): void;
  notice(event: string, fields?: ActionLogFields): void;
  warning(event: string, fields?: ActionLogFields): void;
  error(event: string, fields?: ActionLogFields): void;
  debug(event: string, fields?: ActionLogFields): void;
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

type LogLevel = "info" | "notice" | "warning" | "error" | "debug";

const sensitiveEnvNamePattern = /(TOKEN|SECRET|PASSWORD|PASS|KEY|AUTH|CREDENTIAL|COOKIE)/i;

export function createRuntimeActionLog(options: {
  logSink?: ActionLogSink;
  env?: NodeJS.ProcessEnv;
}): RuntimeActionLog {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (sensitiveEnvNamePattern.test(key)) {
      addSecret(secrets, value);
    }
  }
  const debugEnabled =
    (options.env ?? process.env).ACTIONS_STEP_DEBUG === "true" ||
    (options.env ?? process.env).PIPR_LOG_LEVEL === "debug";
  const sink = options.logSink ?? noopActionLogSink;
  const writer = structuredLogWriter(sink, secrets);
  const logger = pino<"notice">(
    {
      base: undefined,
      level: debugEnabled ? "debug" : "info",
      timestamp: false,
      messageKey: "event",
      customLevels: {
        notice: 35,
      },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    writer.stream,
  );

  return {
    debugEnabled,
    writesToSink: options.logSink !== undefined,
    info(event, fields) {
      writer.level = "info";
      logger.info(compactFields(fields, secrets), redact(event, secrets));
    },
    notice(event, fields) {
      writer.level = "notice";
      logger.notice(compactFields(fields, secrets), redact(event, secrets));
    },
    warning(event, fields) {
      writer.level = "warning";
      logger.warn(compactFields(fields, secrets), redact(event, secrets));
    },
    error(event, fields) {
      writer.level = "error";
      logger.error(compactFields(fields, secrets), redact(event, secrets));
    },
    debug(event, fields) {
      if (debugEnabled) {
        writer.level = "debug";
        logger.debug(compactFields(fields, secrets), redact(event, secrets));
      }
    },
    text(level, event, text) {
      if (level === "debug" && !debugEnabled) {
        return;
      }
      const message = `${structuredLine(logger, writer, level, redact(event, secrets))}\n${redact(text, secrets)}`;
      sinkForLevel(sink, level)(message);
    },
    textSnippet(level, event, text, snippetOptions) {
      if (level === "debug" && !debugEnabled) {
        return;
      }
      const message = `${structuredLine(logger, writer, level, redact(event, secrets))}\n${formatTextSnippet(
        text,
        secrets,
        snippetOptions,
      )}`;
      sinkForLevel(sink, level)(message);
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
  fields: ActionLogFields | undefined,
  secrets: Set<string>,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
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

function structuredLogWriter(
  sink: ActionLogSink,
  secrets: Set<string>,
): {
  level: LogLevel;
  stream: pino.DestinationStream;
} {
  const writer = {
    level: "info" as LogLevel,
    stream: {
      write(line: string) {
        sinkForLevel(sink, writer.level)(redact(line.trimEnd(), secrets));
      },
    },
  };
  return writer;
}

function structuredLine(
  logger: pino.Logger<"notice">,
  writer: ReturnType<typeof structuredLogWriter>,
  level: LogLevel,
  event: string,
): string {
  let line = "";
  const previousStream = writer.stream.write;
  writer.stream.write = (value) => {
    line = value.trimEnd();
  };
  writer.level = level;
  logger[logMethod(level)]({}, event);
  writer.stream.write = previousStream;
  return line;
}

function logMethod(level: LogLevel): "info" | "notice" | "warn" | "error" | "debug" {
  if (level === "warning") {
    return "warn";
  }
  return level;
}

function sinkForLevel(sink: ActionLogSink, level: LogLevel): (message: string) => void {
  if (level === "warning") {
    return sink.warning.bind(sink);
  }
  return sink[level].bind(sink);
}

const noopActionLogSink: ActionLogSink = {
  info() {},
  notice() {},
  warning() {},
  error() {},
  debug() {},
  async group(_name, run) {
    return await run();
  },
};
