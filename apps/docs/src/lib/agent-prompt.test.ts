import { describe, expect, it } from "bun:test";
import { piprAgentSetupPrompt } from "./agent-prompt";

describe("piprAgentSetupPrompt", () => {
  it("preflights install and loads the bundled skill before init", () => {
    expect(piprAgentSetupPrompt).toContain("command -v pipr");
    expect(piprAgentSetupPrompt.indexOf("pipr skill")).toBeLessThan(
      piprAgentSetupPrompt.indexOf("pipr init"),
    );
    expect(piprAgentSetupPrompt).not.toContain("curl -fsSL https://pipr.run/install.sh | sh");
  });

  it("requires the pre-init setup interview unless defaults are explicit", () => {
    expect(piprAgentSetupPrompt).toContain("Before any `pipr init`, interview me");
    expect(piprAgentSetupPrompt).toContain("recipe or review goal");
    expect(piprAgentSetupPrompt).toContain("provider");
    expect(piprAgentSetupPrompt).toContain("model");
    expect(piprAgentSetupPrompt).toContain("secret env var names");
    expect(piprAgentSetupPrompt).toContain("trigger mode");
    expect(piprAgentSetupPrompt).toContain("publication behavior");
    expect(piprAgentSetupPrompt).toContain("existing-file handling");
    expect(piprAgentSetupPrompt).toContain("unless I explicitly say to use Pipr defaults");
  });
});
