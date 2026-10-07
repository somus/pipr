import { describe, expect, it } from "bun:test";
import { buildRunArtifactName, parseRunArtifactName } from "../run-artifact-name.js";

const executionId = "0123456789abcdef0123456789abcdef";

describe("run artifact names", () => {
  it("builds change-scoped and generic names that parse back to the same identity", () => {
    const scoped = buildRunArtifactName({ executionId, protection: "age", changeNumber: 42 });
    const generic = buildRunArtifactName({ executionId, protection: "metadata" });

    expect(scoped).toBe(`pipr-run-v1-age-pr-42-${executionId}`);
    expect(generic).toBe(`pipr-run-v1-metadata-${executionId}`);
    expect(parseRunArtifactName(scoped)).toEqual({
      executionId,
      protection: "age",
      changeNumber: 42,
    });
    expect(parseRunArtifactName(generic)).toEqual({ executionId, protection: "metadata" });
  });

  it("accepts names without a protection segment and rejects foreign names", () => {
    expect(parseRunArtifactName(`pipr-run-v1-pr-7-${executionId}`)).toEqual({
      executionId,
      changeNumber: 7,
    });
    expect(parseRunArtifactName(`pipr-run-v1-${executionId}`)).toEqual({ executionId });
    expect(parseRunArtifactName(`pipr-run-v1-unknown-${executionId}`)).toBeUndefined();
    expect(parseRunArtifactName("coverage")).toBeUndefined();
  });
});
