import type { OfficialInitRecipe } from "./types.js";

export const deepReviewRecipe = {
  id: "deep-review",
  title: "Deep Review",
  description:
    "Full-context review with focused units for large changes and a conditional concurrency lane.",
  sourceTools: ["PR-AF", "CodeRabbit", "Greptile"],
  configTs: `import { definePipr } from "@usepipr/sdk";
import type { DiffManifest, ReviewFinding, ReviewResult } from "@usepipr/sdk";

const maxUnitCharacters = 25_000;
const minimumFilesToShard = 12;

const reviewInstructions = \`
  Review the change for concrete correctness, security, reliability, performance,
  and test-coverage defects. Inspect changed behavior before writing findings.
  Use repository reads to resolve relevant callers, callees, consumers, sibling
  paths, tests, and base/head behavior. Report only a reachable failure caused or
  exposed by changed code. Allow zero findings. Keep each finding concise and put
  the concrete trigger and impact in its body.
\`;

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 25 } });

  const reviewer = pipr.agent({
    name: "deep-reviewer",
    model,
    instructions: reviewInstructions,
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "10m",
    prompt: (input: { manifest: DiffManifest; context?: unknown }) => pipr.prompt\`
      \${pipr.section("Review context", pipr.json(input.context ?? {}, { maxCharacters: 60000 }))}
    \`,
  });

  const concurrencyReviewer = reviewer.extend({
    name: "deep-concurrency-reviewer",
    instructions: \`
      Review only concurrency, asynchronous control-flow, and lifecycle defects.
      Trace shared reads and writes, atomicity, locks, cache publication, retries,
      cancellation, cleanup, shutdown, and error propagation. Check whether
      promises, callbacks, goroutines, threads, and background work are awaited,
      synchronized, and ordered as callers require. Report only a concrete race,
      lost update, duplicate effect, leak, deadlock, or unhandled failure with a
      reachable trigger.
    \`,
  });

  const task = pipr.task({
    name: "deep-review",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest();
      const sharded = manifest.files.length >= minimumFilesToShard;
      const unitManifests = sharded ? chunkManifest(manifest, maxUnitCharacters) : [];
      const reviewConcurrency = !sharded && hasConcurrencySignals(manifest);
      let stopScheduling = false;
      const trackLaneFailure = async <T>(lane: Promise<T>): Promise<T> => {
        try {
          return await lane;
        } catch (error) {
          stopScheduling = true;
          throw error;
        }
      };
      const runFocusedUnits = async () => {
        const results: ReviewResult[] = [];
        for (const [index, unitManifest] of unitManifests.entries()) {
          if (stopScheduling) {
            break;
          }
          results.push(
            await trackLaneFailure(
              ctx.pi.run(reviewer, {
                manifest: unitManifest,
                context: {
                  reviewScale: "unit",
                  reviewUnit: index + 1,
                  reviewUnits: unitManifests.length,
                },
              }),
            ),
          );
        }
        return results;
      };

      const lanes = [
        trackLaneFailure(
          ctx.pi.run(reviewer, { manifest, context: { reviewScale: "full" } }),
        ),
        runFocusedUnits(),
        reviewConcurrency
          ? trackLaneFailure(ctx.pi.run(concurrencyReviewer, { manifest }))
          : Promise.resolve(undefined),
      ] as const;
      const [full, unitResults, concurrency] = await (async () => {
        try {
          return await Promise.all(lanes);
        } catch (error) {
          stopScheduling = true;
          await Promise.allSettled(lanes);
          throw error;
        }
      })();

      const findings = deduplicateFindings([
        ...full.inlineFindings,
        ...unitResults.flatMap((result) => result.inlineFindings),
        ...(concurrency?.inlineFindings ?? []),
      ]);
      await ctx.comment({
        main: "Deep review completed.",
        inlineFindings: findings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr deep-review", permission: "write", task });
});

function hasConcurrencySignals(manifest: DiffManifest): boolean {
  const changedText = manifest.files
    .flatMap((file) => file.commentableRanges.map((range) => range.preview ?? ""))
    .join("\\n");
  const searchableText = changedText
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ");
  return /\\b(?:async|await|promise|goroutine|mutex|lock|thread|queue|cache|retry|concurrent|atomic|shutdown|deadlock|livelock|spinlock|rwlock)\\b/i.test(
    searchableText,
  );
}

function chunkManifest(manifest: DiffManifest, maxCharacters: number): DiffManifest[] {
  const units: DiffManifest[] = [];
  let files: DiffManifest["files"] = [];

  for (const file of manifest.files) {
    const candidate = manifestWithFiles(manifest, [...files, file]);
    if (files.length > 0 && JSON.stringify(candidate).length > maxCharacters) {
      units.push(manifestWithFiles(manifest, files));
      files = [];
    }
    if (JSON.stringify(manifestWithFiles(manifest, [file])).length <= maxCharacters) {
      files = [...files, file];
      continue;
    }
    if (file.commentableRanges.length === 0) {
      units.push(manifestWithFiles(manifest, [file]));
      continue;
    }
    for (const ranges of chunkRanges(file.commentableRanges, maxCharacters / 2)) {
      const hunkIndexes = new Set(ranges.map((range) => range.hunkIndex));
      units.push(
        manifestWithFiles(manifest, [
          {
            ...file,
            hunks: file.hunks.filter((hunk) => hunkIndexes.has(hunk.hunkIndex)),
            commentableRanges: ranges,
          },
        ]),
      );
    }
  }

  if (files.length > 0) {
    units.push(manifestWithFiles(manifest, files));
  }
  return units;
}

function chunkRanges(
  ranges: DiffManifest["files"][number]["commentableRanges"],
  maxCharacters: number,
): Array<DiffManifest["files"][number]["commentableRanges"]> {
  const chunks: Array<DiffManifest["files"][number]["commentableRanges"]> = [];
  let current: DiffManifest["files"][number]["commentableRanges"] = [];

  for (const range of ranges) {
    if (current.length > 0 && JSON.stringify([...current, range]).length > maxCharacters) {
      chunks.push(current);
      current = [];
    }
    current = [...current, range];
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function manifestWithFiles(
  manifest: DiffManifest,
  files: DiffManifest["files"],
): DiffManifest {
  return {
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    mergeBaseSha: manifest.mergeBaseSha,
    files,
  };
}

function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = \`\${finding.path}:\${finding.rangeId}:\${finding.side}:\${finding.startLine}:\${finding.endLine}:\${finding.body}\`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
`,
} as const satisfies OfficialInitRecipe;
