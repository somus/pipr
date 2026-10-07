type EvalRunMode = "live" | "deterministic";

const inheritedEnvNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "BUN_INSTALL",
  "USER",
  "LOGNAME",
] as const;

export function evalSubprocessEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvNames) {
    const value = sourceEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

export function evalReviewEnv(options: {
  mode: EvalRunMode;
  sourceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const sourceEnv = options.sourceEnv ?? process.env;
  const env = evalSubprocessEnv(sourceEnv);
  env.DEEPSEEK_API_KEY =
    options.mode === "deterministic" ? "pipr-eval-dummy-key" : assertLiveEvalEnv(sourceEnv);
  return env;
}

/** Returns the live model key, failing fast when live prompt evals cannot reach the provider. */
export function assertLiveEvalEnv(sourceEnv: NodeJS.ProcessEnv = process.env): string {
  const value = sourceEnv.DEEPSEEK_API_KEY;
  if (!value) {
    throw new Error("DEEPSEEK_API_KEY is required for live prompt evals");
  }
  return value;
}
