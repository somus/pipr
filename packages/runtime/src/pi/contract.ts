import { modelThinkingLevels } from "@usepipr/sdk";
import { z } from "zod";
import { customModelEndpointSchema } from "../agent-worker/protocol.js";

const nonEmptyStringSchema = z.string().min(1);
const piProviderIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/);
const piApiKeyEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const piProviderProfileSchema = z.strictObject({
  id: piProviderIdSchema,
  provider: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  apiKeyEnv: piApiKeyEnvNameSchema.optional(),
  /** Other variables the provider reads, such as an account id, forwarded to the agent worker. */
  providerEnv: z.array(piApiKeyEnvNameSchema).optional(),
  /** Variables that authenticate the provider in place of `apiKeyEnv`, for models using the provider's default key. */
  credentialEnv: z.array(piApiKeyEnvNameSchema).optional(),
  thinking: z.enum(modelThinkingLevels).optional(),
  /** OpenAI-compatible endpoint of a provider declared with `pipr.provider`. */
  endpoint: customModelEndpointSchema.optional(),
});
