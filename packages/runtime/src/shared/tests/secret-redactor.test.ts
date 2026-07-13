import { describe, expect, it } from "bun:test";
import { createBetterleaksSecretRedactor } from "../betterleaks-redactor.js";

describe("createBetterleaksSecretRedactor", () => {
  it("redacts Betterleaks spans across batched Unicode targets", async () => {
    const detected = "scanner-only-value";
    const redactor = createBetterleaksSecretRedactor({
      scan: async (payload) => {
        const lines = payload.split("\n");
        const lineIndex = lines.findIndex((line) => line.includes(detected));
        const line = lines[lineIndex];
        if (lineIndex < 0 || line === undefined) {
          throw new Error("test payload omitted detected value");
        }
        const startColumn =
          new TextEncoder().encode(line.slice(0, line.indexOf(detected))).length +
          1 +
          (lineIndex > 0 ? 1 : 0);
        const detectedBytes = new TextEncoder().encode(detected).length;
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              StartLine: lineIndex + 1,
              EndLine: lineIndex + 1,
              StartColumn: startColumn,
              EndColumn: startColumn + detectedBytes - 1,
            },
          ]),
        };
      },
    });

    const result = await redactor.redact([
      `Unicode 😀 é before ${detected} after.`,
      "Safe content.",
    ]);

    expect(result).toEqual([
      { value: "Unicode 😀 é before [redacted secret] after.", detected: true },
      { value: "Safe content.", detected: false },
    ]);
  });

  it("masks registered values without changing scanner-clean content", async () => {
    const redactor = createBetterleaksSecretRedactor({
      scan: async () => ({ exitCode: 0, stdout: "[]" }),
    });
    redactor.addSecret("registered-value");

    const result = await redactor.redact([
      "Known registered-value and model-api_key-abcdefghijklmnop.",
    ]);

    expect(result).toEqual([
      {
        value: "Known [redacted secret] and model-api_key-abcdefghijklmnop.",
        detected: true,
      },
    ]);
  });

  it.each([
    { name: "scanner failure", exitCode: 2, stdout: "[]" },
    { name: "malformed report", exitCode: 1, stdout: "not-json" },
  ])("fails closed on $name", async ({ exitCode, stdout }) => {
    const redactor = createBetterleaksSecretRedactor({
      scan: async () => ({ exitCode, stdout }),
    });

    await expect(redactor.redact(["publication body"])).rejects.toThrow(
      "Secret redaction failed; publication aborted",
    );
  });
});
