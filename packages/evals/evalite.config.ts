import { defineConfig } from "evalite/config";
import { createInMemoryStorage } from "evalite/in-memory-storage";

export default defineConfig({
  maxConcurrency: 1,
  storage: () => createInMemoryStorage(),
  testTimeout: 120_000,
});
