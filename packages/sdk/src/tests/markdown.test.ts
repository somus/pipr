import { describe, expect, it } from "bun:test";
import { md } from "../index.js";

describe("md", () => {
  it("escapes interpolated HTML and hidden markers but keeps Markdown and code", () => {
    const body = "Use <script>alert(1)</script> and `<b>` safely <!-- pipr:marker -->";
    expect(String(md`**Finding:** ${body}`)).toBe(
      "**Finding:** Use &lt;script>alert(1)&lt;/script> and `<b>` safely &lt;!-- pipr:marker -->",
    );
  });

  it("escapes text after an unclosed code fence", () => {
    const body = "```\n<!-- pipr:main-comment change=1 version=1 -->";
    expect(String(md`${body}`)).toBe("```\n&lt;!-- pipr:main-comment change=1 version=1 -->");
    expect(String(md`${"```\n<b>\n```"}`)).toBe("```\n<b>\n```");
  });

  it("does not double-escape nested md values and trusts md.raw", () => {
    const nested = md`Inner ${"<i>"}`;
    expect(String(md`Outer ${nested} ${md.raw("<details>")}`)).toBe("Outer Inner &lt;i> <details>");
  });

  it("strips common indentation and omits empty values", () => {
    const optional: string | undefined = undefined;
    expect(
      String(md`
        ## Title

        ${optional}
        Body
      `),
    ).toBe("## Title\n\nBody");
  });

  it("renders lists, tables, details, labels, callouts, and blocks", () => {
    expect(String(md.list(["one\ntwo", "<x>"]))).toBe("- one two\n- &lt;x>");
    expect(String(md.list(["a", "b"], { ordered: true }))).toBe("1. a\n2. b");
    expect(
      String(
        md.table([{ severity: "high", title: "a|b" }], { severity: "Severity", title: "Title" }),
      ),
    ).toBe("| Severity | Title |\n| --- | --- |\n| high | a\\|b |");
    expect(String(md.table([], ["severity"]))).toBe("");
    expect(String(md.details("Why", "Because <b>"))).toBe(
      "<details>\n<summary>Why</summary>\n\nBecause &lt;b>\n\n</details>",
    );
    expect(String(md.details("Why", ""))).toBe("");
    expect(String(md.label("test-coverage"))).toBe("Test coverage");
    expect(String(md.callout({ icon: "🔴", title: "High", body: "Bad\nthing" }))).toBe(
      "> 🔴 **High:** Bad thing",
    );
    expect(String(md.blocks("a", undefined, md.list([]), "b"))).toBe("a\n\nb");
  });
});
