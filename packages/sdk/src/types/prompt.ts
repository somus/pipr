/** Markdown text accepted by review comments and command replies. */
export type Markdown = string;

/** Prompt text accepted by agent instructions and prompt functions. */
export type PromptSource = string | PromptText;
/** Value accepted by prompt rendering helpers. */
export type PromptValue = unknown;

/** Structured prompt text produced by `pipr.prompt`, `pipr.section`, or `pipr.json`. */
export type PromptText = {
  readonly kind: "pipr.prompt";
  readonly value: string;
};

/** Options for rendering a value as JSON prompt text. */
export type JsonPromptOptions = {
  pretty?: boolean;
  maxCharacters?: number;
};
