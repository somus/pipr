import { z } from "zod";

export const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const piBuiltinToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const piReadOnlyToolNames = ["read", "grep", "find", "ls"] as const;
export type PiReadOnlyToolName = (typeof piReadOnlyToolNames)[number];
export const piRequiredCliFlags = [
  "--provider",
  "--model",
  "--system-prompt",
  "--mode",
  "--print",
  "--no-session",
  "--session-dir",
  "--tools",
  "--extension",
  "--no-context-files",
  "--no-approve",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--thinking",
] as const;

const nonEmptyStringSchema = z.string().min(1);
const piProviderIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/);
const piApiKeyEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

const piThinkingLevelSchema = z.enum(piThinkingLevels);
const piReadOnlyToolNamesSchema = z.tuple([
  z.literal("read"),
  z.literal("grep"),
  z.literal("find"),
  z.literal("ls"),
]);

export const piProviderProfileSchema = z.strictObject({
  id: piProviderIdSchema,
  provider: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  apiKeyEnv: piApiKeyEnvNameSchema,
  thinking: piThinkingLevelSchema.optional(),
});

const piProviderInvocationSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  apiKeyEnv: piApiKeyEnvNameSchema,
  thinking: piThinkingLevelSchema,
  tools: piReadOnlyToolNamesSchema,
});

export type PiProviderProfile = z.infer<typeof piProviderProfileSchema>;
export type PiProviderInvocation = z.infer<typeof piProviderInvocationSchema>;

export function parsePiProviderProfile(value: unknown): PiProviderProfile {
  return piProviderProfileSchema.parse(value);
}

export function parsePiProviderInvocation(value: unknown): PiProviderInvocation {
  return piProviderInvocationSchema.parse(value);
}
