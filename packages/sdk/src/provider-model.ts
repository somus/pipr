import { z } from "zod";
import type { ProviderModelOptions } from "./types/config.js";

/** Metadata overrides a custom provider declares for one model; the runtime forwards them to the agent worker. */
export const providerModelOptionsSchema: z.ZodType<ProviderModelOptions> = z.strictObject({
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  cost: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
    })
    .optional(),
});
