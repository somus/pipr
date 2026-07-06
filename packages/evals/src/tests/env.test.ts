import { describe, expect, it } from "bun:test";
import { evalReviewEnv, evalSubprocessEnv } from "../env.js";

describe("eval environment boundaries", () => {
  it("does not pass arbitrary caller secrets to helper subprocesses", () => {
    const env = evalSubprocessEnv({
      PATH: "/bin",
      HOME: "/tmp/pipr-home",
      DEEPSEEK_API_KEY: "real-provider-key",
      PIPR_EVAL_FORBIDDEN_HELPER_ENV: "do-not-leak",
      UNRELATED_SECRET_TOKEN: "do-not-leak",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/tmp/pipr-home");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.UNRELATED_SECRET_TOKEN).toBeUndefined();
    expect(env.PIPR_EVAL_FORBIDDEN_HELPER_ENV).toBeUndefined();
  });

  it("passes only the model key required for live review runs", () => {
    const env = evalReviewEnv({
      mode: "live",
      sourceEnv: {
        PATH: "/bin",
        DEEPSEEK_API_KEY: "real-provider-key",
        UNRELATED_SECRET_TOKEN: "do-not-leak",
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.DEEPSEEK_API_KEY).toBe("real-provider-key");
    expect(env.UNRELATED_SECRET_TOKEN).toBeUndefined();
  });

  it("requires a model key for live review runs", () => {
    expect(() =>
      evalReviewEnv({
        mode: "live",
        sourceEnv: {
          PATH: "/bin",
        },
      }),
    ).toThrow("DEEPSEEK_API_KEY is required for live prompt evals");
  });

  it("uses a dummy provider key for deterministic review runs", () => {
    const env = evalReviewEnv({
      mode: "deterministic",
      sourceEnv: {
        PATH: "/bin",
        DEEPSEEK_API_KEY: "real-provider-key",
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.DEEPSEEK_API_KEY).toBe("pipr-eval-dummy-key");
  });
});
