const defaultImage = "pipr-action:act";
const dockerImagePattern = /^(\s*)image:\s*docker:\/\/\S+(?:\s+#.*)?\s*$/m;
const actArgsPattern = /^(\s*)args:\s*$/m;

export function renderActActionMetadata(
  source: string,
  image = defaultImage,
  options: { entrypointScript?: string } = {},
): string {
  if (!image.trim()) {
    throw new Error("PIPR_ACTION_IMAGE must not be empty");
  }
  if (!dockerImagePattern.test(source)) {
    throw new Error("action metadata must contain runs.image: docker://...");
  }
  let rendered = source.replace(
    dockerImagePattern,
    `$1image: docker://${image}${options.entrypointScript ? "\n$1entrypoint: /usr/local/bin/bun" : ""}`,
  );
  if (options.entrypointScript) {
    if (!actArgsPattern.test(rendered)) {
      throw new Error("action metadata must contain runs.args for act fixture wrapper");
    }
    rendered = rendered.replace(actArgsPattern, `$1args:\n$1  - ${options.entrypointScript}`);
  }
  return rendered;
}
