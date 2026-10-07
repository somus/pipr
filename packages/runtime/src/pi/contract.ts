import { modelThinkingLevels } from "@usepipr/sdk";
import { z } from "zod";

export const piThinkingLevels = modelThinkingLevels;

const nonEmptyStringSchema = z.string().min(1);
const piProviderIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/);
const piApiKeyEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

const piThinkingLevelSchema = z.enum(piThinkingLevels);

export const piProviderProfileSchema = z.strictObject({
  id: piProviderIdSchema,
  provider: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  apiKeyEnv: piApiKeyEnvNameSchema.optional(),
  /** Other variables the provider reads, such as an account id, forwarded to the agent worker. */
  providerEnv: z.array(piApiKeyEnvNameSchema).optional(),
  /** Variables that authenticate the provider in place of `apiKeyEnv`, for models using the provider's default key. */
  credentialEnv: z.array(piApiKeyEnvNameSchema).optional(),
  thinking: piThinkingLevelSchema.optional(),
});

export type PiProviderProfile = z.infer<typeof piProviderProfileSchema>;

export function parsePiProviderProfile(value: unknown): PiProviderProfile {
  return piProviderProfileSchema.parse(value);
}
