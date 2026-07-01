import { describe, expect, it } from "bun:test";
import { memoryActionLogSink } from "../../tests/helpers/action-log-sink.js";
import { createRuntimeActionLog } from "../logging.js";

describe("createRuntimeActionLog", () => {
  it("redacts JSON-escaped secrets in structured fields", () => {
    const sink = memoryActionLogSink();
    const secret = 'abc"def';
    const log = createRuntimeActionLog({ logSink: sink.logSink, env: { API_KEY: secret } });

    log.error("boom", { error: secret, values: [secret] });

    const output = sink.messages.join("\n");
    expect(output).toContain('"error":"***"');
    expect(output).toContain('"values":["***"]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('abc\\"def');
  });

  it("emits structured debug logs when PIPR_LOG_LEVEL enables debug", () => {
    const sink = memoryActionLogSink();
    const log = createRuntimeActionLog({
      logSink: sink.logSink,
      env: { PIPR_LOG_LEVEL: "debug" },
    });

    log.debug("debug event", { flag: true });
    log.text("debug", "debug text", "body");

    const output = sink.messages.join("\n");
    expect(output).toContain('"level":"debug"');
    expect(output).toContain('"event":"debug event"');
    expect(output).toContain('"event":"debug text"');
    expect(output).toContain("body");
  });

  it("redacts text snippets before bounding output", () => {
    const sink = memoryActionLogSink();
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
    const log = createRuntimeActionLog({
      logSink: sink.logSink,
      env: { DEEPSEEK_API_KEY: secret },
    });

    log.textSnippet("error", "pi stderr", `${"x".repeat(8180)}${secret}\nafter`);

    const output = sink.messages.join("\n");
    expect(output).toContain("***");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(secret.slice(0, 24));
  });
});
