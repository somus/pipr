import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const twoslashCompilerOptions = {
  baseUrl: repoRoot,
  paths: {
    "@usepipr/sdk": ["packages/sdk/src/index.ts"],
    "@usepipr/sdk/internal": ["packages/sdk/src/internal.ts"],
  },
};
