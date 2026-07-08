export const piprAgentSetupPrompt = [
  "Install and configure Pipr in this repository.",
  "First run `command -v pipr && pipr --help`; skip installation when Pipr is already available.",
  "If Pipr is missing, ask before installing it with the official release installer.",
  "Then run `pipr skill` and follow the bundled `pipr-setup` skill before choosing any `pipr init` flags.",
  "Before any `pipr init`, interview me for recipe or review goal, provider, model, secret env var names, trigger mode, publication behavior, and existing-file handling unless I explicitly say to use Pipr defaults.",
  "Run the chosen `pipr init` command, customize `.pipr/config.ts` only as needed, and verify with `pipr inspect` and `pipr check`.",
].join(" ");
