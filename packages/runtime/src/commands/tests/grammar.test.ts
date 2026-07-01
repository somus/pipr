import { describe, expect, it } from "bun:test";
import {
  commandPatternPrefixMatches,
  firstNonEmptyLine,
  isPiprCommandLine,
  parseCommandPattern,
} from "../grammar.js";

describe("command grammar", () => {
  it("recognizes pipr command lines and triggers by token", () => {
    expect(firstNonEmptyLine("\n  @pipr review\n  ignored")).toBe("@pipr review");
    expect(isPiprCommandLine("@pipr")).toBe(true);
    expect(isPiprCommandLine("@pipr review")).toBe(true);
    expect(isPiprCommandLine("@piprbot review")).toBe(false);
  });

  it("parses required positional and optional named arguments", () => {
    expect(
      parseCommandPattern("@pipr explain <finding> [--scope <scope>]", "@pipr explain FND-1"),
    ).toEqual({
      ok: true,
      value: { finding: "FND-1" },
    });
    expect(
      parseCommandPattern(
        "@pipr explain <finding> [--scope <scope>]",
        "@pipr explain FND-1 --scope full",
      ),
    ).toEqual({
      ok: true,
      value: { finding: "FND-1", scope: "full" },
    });
    expect(
      parseCommandPattern("@pipr explain <finding> [--scope <scope>]", "@pipr explain"),
    ).toEqual({
      ok: false,
      error: "Expected '<finding>'",
    });
    expect(
      parseCommandPattern(
        "@pipr explain <finding> [--scope <scope>]",
        "@pipr explain FND-1 trailing",
      ),
    ).toEqual({
      ok: false,
      error: "Unexpected argument 'trailing'",
    });
  });

  it("captures the final rest argument", () => {
    expect(parseCommandPattern("@pipr ask <question...>", "@pipr ask what does this do?")).toEqual({
      ok: true,
      value: { question: "what does this do?" },
    });
    expect(parseCommandPattern("@pipr ask <question...>", "@pipr ask")).toEqual({
      ok: false,
      error: "Expected '<question...>'",
    });
  });

  it("rejects rest captures outside the final required position", () => {
    const error = "Rest capture '<question...>' must be the final required command pattern token";

    expect(parseCommandPattern("@pipr ask [<question...>]", "@pipr ask now")).toEqual({
      ok: false,
      error,
    });
    expect(parseCommandPattern("@pipr ask <question...> --json", "@pipr ask now --json")).toEqual({
      ok: false,
      error,
    });
    expect(commandPatternPrefixMatches("@pipr ask [<question...>]", "@pipr ask now")).toBe(false);
  });

  it("matches static prefixes before validating full patterns", () => {
    expect(commandPatternPrefixMatches("@pipr explain <finding>", "@pipr explain FND-1")).toBe(
      true,
    );
    expect(commandPatternPrefixMatches("@pipr explain <finding>", "@pipr review")).toBe(false);
  });
});
