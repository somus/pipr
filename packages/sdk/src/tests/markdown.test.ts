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

  it("keeps whitespace inside interpolated content", () => {
    const body = "Fix this:\n\n```make\nbuild:\n\tgo build\n\n\n\tgo vet\n```\n\n    indented code";
    expect(
      String(md`
        **Finding:**

        ${body}
      `),
    ).toBe(`**Finding:**\n\n${body}`);
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

const rawHtmlLine = /^\s{0,3}<[a-zA-Z/!?]/m;

describe("md escaping", () => {
  it.each([
    ["an indented fence", "intro\n\n    ```\n<!-- pipr:main-comment change=1 -->\n```"],
    ["a fence opened inside a blockquote", "> ```\n<!-- pipr:x -->\n```"],
    ["a fence opened inside a list item", "- a\n  ```\n<!-- pipr:x -->\n```"],
    ["a tilde fence hiding a backtick fence", "~~~\n```\n~~~\n<!-- pipr:x -->\n```"],
    ["inline code whose opener spans lines", "`a\n`<b>` x`"],
    ["a backslash-escaped backtick", "\\`<b>`"],
    ["inline code split by a table pipe", "| `a | <b> | b` |"],
  ])("escapes HTML that Markdown would not render as code: %s", (_name, body) => {
    const rendered = String(md`${body}`);
    expect(rendered).not.toMatch(rawHtmlLine);
    expect(rendered).not.toContain("<b>");
    expect(rendered).not.toContain("<!--");
  });

  it("escapes code that becomes prose in the surrounding template", () => {
    expect(String(md`\`${"x`<b>`y"}\``)).not.toContain("<b>");
    expect(String(md`> ${"```\n<!-- pipr:x -->\n```"}`)).not.toContain("<!--");
    expect(String(md.list(["~~~\n<b>\n~~~"]))).not.toContain("<b>");
    const nested = md`${"`<b>`"}`;
    expect(String(nested)).toBe("`<b>`");
    expect(String(md`\`${nested}`)).not.toContain("<b>");
  });

  it.each([
    ["a closed fence", "```ts\nconst a = <b>1</b>;\n```"],
    ["a longer fence containing a shorter one", "````md\n```\n<b>\n```\n````"],
    ["a tilde fence", "~~~\n<b>\n~~~"],
    ["inline code", "use `<b>` here"],
    ["double-backtick inline code", "use ``a ` <b>`` here"],
  ])("keeps %s unescaped", (_name, body) => {
    expect(String(md`${body}`)).toBe(body);
  });

  it.each([
    ["entity tricks stay inert", md`${"&lt;!-- x --> &#60;b>"}`, "&amp;lt;!-- x --> &amp;#60;b>"],
    ["autolinks", md`${"<https://example.com>"}`, "&lt;https://example.com>"],
    ["closing tags in lists", md.list(["</details>"]), "- &lt;/details>"],
    [
      "closing tags in details summaries",
      md.details("</summary><b>x", "body"),
      "<details>\n<summary>&lt;/summary>&lt;b>x</summary>\n\nbody\n\n</details>",
    ],
    [
      "HTML and pipes in table headers",
      md.table([{ a: 1 }], { a: "<b>|x" }),
      "| &lt;b>\\|x |\n| --- |\n| 1 |",
    ],
    [
      "camelCase table columns",
      md.table([{ filePath: "<i>" }], ["filePath"]),
      "| File path |\n| --- |\n| &lt;i> |",
    ],
    ["md.line", md.line("a\n<b>\n  c"), "a &lt;b> c"],
    ["callout icons", md.callout({ icon: "<img src=x>", title: "T" }), "> &lt;img src=x> **T**"],
  ])("escapes %s", (_name, rendered, expected) => {
    expect(String(rendered)).toBe(expected);
  });
});
