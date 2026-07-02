import { fileURLToPath } from "node:url";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { remarkMdxFiles } from "fumadocs-core/mdx-plugins/remark-mdx-files";
import { remarkSteps } from "fumadocs-core/mdx-plugins/remark-steps";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { transformerTwoslash } from "fumadocs-twoslash";
import { createGenerator, remarkAutoTypeTable } from "fumadocs-typescript";
import { repoRoot, twoslashCompilerOptions } from "./twoslash-config.js";

const guideTwoslashIncludes = new Map<string, string>([
  [
    "pipr-builder",
    `import type { PiprBuilder } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
// ---cut---`,
  ],
  [
    "pipr-z-builder",
    `import { z } from "@usepipr/sdk";
import type { PiprBuilder } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
// ---cut---`,
  ],
  [
    "pipr-reviewer",
    `import type { PiprBuilder, Reviewer } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const reviewer: Reviewer;
// ---cut---`,
  ],
  [
    "pipr-model",
    `import type { ModelProfile, PiprBuilder } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const model: ModelProfile;
// ---cut---`,
  ],
  [
    "pipr-models",
    `import type { ModelProfile, PiprBuilder } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const model: ModelProfile;
declare const backupModel: ModelProfile;
// ---cut---`,
  ],
  [
    "pipr-task",
    `import type { PiprBuilder, Task } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const task: Task;
// ---cut---`,
  ],
  [
    "pipr-security-task",
    `import type { PiprBuilder, Task } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const securityTask: Task;
// ---cut---`,
  ],
  [
    "pipr-ask-task",
    `import type { PiprBuilder, Task } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const ask: Task<{ question: string }>;
// ---cut---`,
  ],
  [
    "pipr-security-agent",
    `import type { Agent, ModelProfile, PiprBuilder, ReviewResult } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const model: ModelProfile;
declare const securityAgent: Agent<{ manifest: unknown }, ReviewResult>;
// ---cut---`,
  ],
  [
    "pipr-ask-agent",
    `import type { Agent, PiprBuilder } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const askAgent: Agent<
  { question: string; manifest: unknown; prior?: unknown },
  { body: string }
>;
// ---cut---`,
  ],
  [
    "pipr-ci-agent",
    `import type { Agent, PiprBuilder } from "@usepipr/sdk";
declare const pipr: PiprBuilder;
declare const ciAgent: Agent<{ log: string }, { body: string }>;
// ---cut---`,
  ],
  [
    "task-context",
    `import type { TaskContext } from "@usepipr/sdk";
declare const ctx: TaskContext;
// ---cut---`,
  ],
  [
    "task-result",
    `import type { ReviewResult, TaskContext } from "@usepipr/sdk";
declare const ctx: TaskContext;
declare const result: ReviewResult;
// ---cut---`,
  ],
  [
    "task-pi-review",
    `import type { Agent, ModelProfile, ReviewResult, TaskContext } from "@usepipr/sdk";
declare const ctx: TaskContext;
declare const reviewer: Agent<Record<string, unknown>, ReviewResult>;
declare const backupModel: ModelProfile;
declare const manifest: unknown;
// ---cut---`,
  ],
]);
const typeTableGenerator = createGenerator({
  tsconfigPath: fileURLToPath(new URL("../../packages/sdk/tsconfig.json", import.meta.url)),
});

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash({
          includesMap: guideTwoslashIncludes,
          twoslashOptions: {
            compilerOptions: twoslashCompilerOptions,
          },
        }),
      ],
    },
    remarkPlugins: [
      remarkMdxFiles,
      remarkSteps,
      [
        remarkAutoTypeTable,
        {
          generator: typeTableGenerator,
          options: {
            basePath: repoRoot,
          },
        },
      ],
    ],
  },
});
