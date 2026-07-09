import { describe, expect, it } from "bun:test";
import { sanitizeTerminalMessage } from "../terminal-output.js";

describe("terminal output", () => {
  it("strips terminal controls while preserving readable text and newlines", () => {
    const message = [
      "bad \u001b[31mred\u001b[0m",
      "next\u001b]0;title\u0007 line",
      "carriage\rreturn",
    ].join("\n");

    expect(sanitizeTerminalMessage(message)).toBe("bad red\nnext line\ncarriagereturn");
  });

  it("strips string and private terminal controls", () => {
    expect(sanitizeTerminalMessage("a\u001bPprivate\u001b\\b\u001bXignored\u001b\\c")).toBe("abc");
  });

  it("strips C1 terminal controls and ST-terminated strings", () => {
    expect(sanitizeTerminalMessage("a\u001bPprivate\u009cb\u001b]0;title\u009cc")).toBe("abc");
    expect(sanitizeTerminalMessage("a\u0090private\u009cb\u009d0;title\u009cc\u009b31md")).toBe(
      "abcd",
    );
  });

  it("strips escape sequences with broad final-byte and intermediate ranges", () => {
    expect(sanitizeTerminalMessage("a\u001b7b\u001b8c\u001b=d\u001b>e\u001bcf")).toBe("abcdef");
    expect(sanitizeTerminalMessage("a\u001b#8b\u001b(Bc")).toBe("abc");
  });

  it("keeps readable text after malformed escape sequences with intermediates", () => {
    expect(sanitizeTerminalMessage("a\u001b \u00a0b")).toBe("a\u00a0b");
  });

  it("drops unterminated terminal controls", () => {
    expect(sanitizeTerminalMessage("before \u001b]0;title")).toBe("before ");
    expect(sanitizeTerminalMessage("before \u001b[31")).toBe("before ");
    expect(sanitizeTerminalMessage("before \u001bPprivate\u001b")).toBe("before ");
    expect(sanitizeTerminalMessage("before \u001b#")).toBe("before ");
  });
});
