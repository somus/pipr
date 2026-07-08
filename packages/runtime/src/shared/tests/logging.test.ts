import { describe, expect, it } from "bun:test";
import { memoryActionLogSink } from "../../tests/helpers/action-log-sink.js";
import { createRuntimeActionLog } from "../logging.js";

describe("createRuntimeActionLog", () => {
  it("redacts JSON-escaped secrets in structured fields", () => {
    const sink = memoryActionLogSink();
    const secret = 'abc"def';
    const log = createRuntimeActionLog({ logSink: sink.logSink, env: { API_KEY: secret } });

    log.error("boom", { error: secret, values: [secret] });

    expect(sink.records).toEqual([
      {
        level: "error",
        event: "boom",
        fields: { error: "***", values: ["***"] },
      },
    ]);
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

    expect(sink.records).toMatchObject([
      {
        level: "debug",
        event: "debug event",
        fields: { flag: true },
      },
      {
        level: "debug",
        event: "debug text",
        fields: {},
        text: "body",
      },
    ]);
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

    expect(sink.records[0]?.text).toContain("***");
    expect(sink.records[0]?.text).not.toContain(secret);
    const output = sink.messages.join("\n");
    expect(output).toContain("***");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(secret.slice(0, 24));
  });

  it("redacts secret-like values that were not registered from the environment", async () => {
    const sink = memoryActionLogSink();
    const token = "github_token_abcdefghijklmnopqrstuvwxyz123456";
    const log = createRuntimeActionLog({ logSink: sink.logSink, env: {} });

    log.error(`failed ${token}`, { error: token, values: [token] });
    log.text("error", "pi invalid output", `stdout ${token}`);
    log.textSnippet("error", "pi stderr", `stderr ${token}`);
    await log.group(`group ${token}`, async () => {});

    expect(sink.records[0]).toEqual({
      level: "error",
      event: "failed [redacted secret]",
      fields: { error: "[redacted secret]", values: ["[redacted secret]"] },
    });
    expect(sink.records[1]?.text).toContain("stdout [redacted secret]");
    expect(sink.records[2]?.text).toContain("stderr [redacted secret]");
    expect(sink.groups).toEqual(["group [redacted secret]"]);
    expect(sink.messages.join("\n")).not.toContain(token);
  });
});
