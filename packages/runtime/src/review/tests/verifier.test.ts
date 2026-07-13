import { describe, expect, it } from "bun:test";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import type { InlineThreadContext } from "../../hosts/types.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  PiprConfig,
  ProviderConfig,
} from "../../types.js";
import type { PiRunner } from "../agent/review-run.js";
import type { PriorReviewState } from "../prior-state.js";
import { runInternalVerifier } from "../verifier.js";

const provider: ProviderConfig = {
  id: "default",
  provider: "deepseek",
  model: "deepseek-v4",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const config: PiprConfig = {
  defaultProvider: "default",
  providers: [provider],
  publication: {
    maxInlineComments: 5,
    showHeader: true,
    showFooter: true,
    showStats: true,
    autoResolve: {
      enabled: true,
      model: "default",
      synchronize: true,
      userReplies: {
        enabled: true,
        respondWhenStillValid: true,
        allowedActors: "author-or-write",
      },
    },
  },
};

const plan = {
  models: [],
  agents: [],
  tasks: [],
  events: [],
  commands: [],
  tools: [],
  schemas: [],
  publication: {},
} as unknown as RuntimePlan;

const event: ChangeRequestEventContext = {
  eventName: "pull_request_review_comment",
  action: "opened",
  rawAction: "created",
  platform: { id: "github" },
  repository: { slug: "local/pipr" },
  change: {
    number: 1,
    title: "Review",
    description: "",
    base: { sha: "base" },
    head: { sha: "new-head" },
  },
  workspace: process.cwd(),
};

const diffManifest: DiffManifest = {
  baseSha: "base",
  headSha: "new-head",
  mergeBaseSha: "base",
  files: [],
};

const priorReviewState: PriorReviewState = {
  version: 1,
  reviewedHeadSha: "old-head",
  selectedTasks: ["review"],
  findings: [
    {
      id: "fnd_existing",
      status: "open",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
      firstSeenHeadSha: "old-head",
      lastSeenHeadSha: "old-head",
      lastCommentedHeadSha: "old-head",
    },
  ],
};

const threadContext: InlineThreadContext = {
  findingId: "fnd_existing",
  findingHeadSha: "old-head",
  parentCommentId: "10",
  parentBody: "<!-- pipr:finding id=fnd_existing head=old-head -->\nThis can fail.",
  threadId: "thread-1",
  threadResolved: false,
  comments: [
    { id: "10", body: "This can fail.", authorLogin: "github-actions[bot]" },
    { id: "11", body: "private reviewer context that should not leak", authorLogin: "octo-dev" },
  ],
};

describe("runInternalVerifier", () => {
  it("resolves fixed user replies and omits unrelated thread bodies from the prompt", async () => {
    let observedPrompt = "";
    const result = await runVerifier({
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "fixed",
            response: "Agreed, this is resolved by the current change.",
          },
        ],
      },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
    });

    expect(result.priorReviewState?.findings[0]?.status).toBe("resolved");
    expect(result.threadActions).toEqual([
      {
        kind: "resolve",
        findingId: "fnd_existing",
        findingHeadSha: "old-head",
        commentId: "10",
        threadId: "thread-1",
        body:
          "Agreed, this is resolved by the current change.\n\n" +
          "Resolved in https://github.com/local/pipr/commit/new-head.",
        responseKey: "new-head:fixed:fnd_existing",
      },
    ]);
    expect(observedPrompt).toContain("This can fail.");
    expect(observedPrompt).toContain("The caller validates this earlier.");
    expect(observedPrompt).not.toContain("private reviewer context that should not leak");
  });

  it("instructs the verifier to respect valid user explanations", async () => {
    let observedPrompt = "";
    await runVerifier({
      replyBody: "This behavior is intentional and documented by the new API contract.",
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "fixed",
            response: "Accepted; the explanation makes this finding unnecessary.",
          },
        ],
      },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
    });

    expect(observedPrompt).toContain("treat a user's technical explanation as evidence");
    expect(observedPrompt).toContain("Respect the PR author's or maintainer's stated intent");
    expect(observedPrompt).toContain("makes the requested change unnecessary");
    expect(observedPrompt).toContain("This behavior is intentional");
  });

  it("includes configured verifier instructions", async () => {
    let observedPrompt = "";
    await runVerifier({
      config: {
        ...config,
        publication: {
          ...config.publication,
          autoResolve: {
            ...config.publication.autoResolve,
            instructions: "Resolve when maintainers explain a deliberate product contract.",
          },
        },
      },
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
    });

    expect(observedPrompt).toContain(
      "Resolve when maintainers explain a deliberate product contract.",
    );
  });

  it("requires one evidence-backed verdict for every supplied finding id", async () => {
    let observedPrompt = "";
    await runVerifier({
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
    });

    expect(observedPrompt).toContain("Return exactly one verdict for every supplied finding ID");
    expect(observedPrompt).toContain("Use only supplied finding IDs; never invent an ID");
    expect(observedPrompt).toContain("Do not repeat user-supplied text unless needed");
  });

  it("replies to still-valid user replies when configured", async () => {
    const result = await runVerifier({
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "still-valid",
            response: "This still applies because the unsafe path remains.",
          },
        ],
      },
    });

    expect(result.priorReviewState?.findings[0]?.status).toBe("open");
    expect(result.threadActions).toEqual([
      {
        kind: "reply",
        findingId: "fnd_existing",
        findingHeadSha: "old-head",
        commentId: "10",
        threadId: "thread-1",
        body: "This still applies because the unsafe path remains.",
        responseKey: "reply-11:still-valid:fnd_existing",
      },
    ]);
  });

  it("keeps still-valid user replies silent when configured", async () => {
    const result = await runVerifier({
      respondWhenStillValid: false,
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "still-valid",
            response: "This still applies because the unsafe path remains.",
          },
        ],
      },
    });

    expect(result.threadActions).toEqual([]);
  });

  it("fails closed when user-reply fixed output omits the required response", async () => {
    const result = await runVerifier({
      output: { findings: [{ id: "fnd_existing", status: "fixed" }] },
    });

    expect(result.priorReviewState?.findings[0]?.status).toBe("open");
    expect(result.threadActions).toEqual([]);
  });

  it("fails closed when user-reply verifier responses have no visible text", async () => {
    const fixed = await runVerifier({
      output: { findings: [{ id: "fnd_existing", status: "fixed", response: "   \n\t" }] },
    });
    const stillValid = await runVerifier({
      output: { findings: [{ id: "fnd_existing", status: "still-valid", response: "   \n\t" }] },
    });

    expect(fixed.priorReviewState?.findings[0]?.status).toBe("open");
    expect(fixed.threadActions).toEqual([]);
    expect(stillValid.priorReviewState?.findings[0]?.status).toBe("open");
    expect(stillValid.threadActions).toEqual([]);
  });

  it("cites the current head commit when synchronizing fixed findings with model prose", async () => {
    const result = await runVerifier({
      mode: { kind: "synchronize" },
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "fixed",
            response: "The changed code now preserves the fallback.",
          },
        ],
      },
    });

    expect(result.threadActions[0]).toMatchObject({
      kind: "resolve",
      body:
        "The changed code now preserves the fallback.\n\n" +
        "Resolved in https://github.com/local/pipr/commit/new-head.",
    });
  });

  it("bounds parent comments and user replies in the verifier prompt", async () => {
    let observedPrompt = "";
    await runVerifier({
      parentBody: `<!-- pipr:finding id=fnd_existing head=old-head -->\n${"a".repeat(5000)}`,
      replyBody: "b".repeat(5000),
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
    });

    expect(observedPrompt).toContain("[truncated]");
    expect(observedPrompt).not.toContain("a".repeat(4500));
    expect(observedPrompt).not.toContain("b".repeat(4500));
  });

  it("fails closed when verifier output is invalid", async () => {
    const result = await runVerifier({
      output: { findings: [{ id: "fnd_existing", status: "fixed", response: "" }] },
    });

    expect(result.priorReviewState).toEqual(priorReviewState);
    expect(result.threadActions).toEqual([]);
  });

  it("fails closed when the verifier omits a candidate or invents an id", async () => {
    const omitted = await runVerifier({ output: { findings: [] } });
    const invented = await runVerifier({
      output: {
        findings: [{ id: "fnd_invented", status: "fixed", response: "Resolved." }],
      },
    });

    expect(omitted.priorReviewState).toEqual(priorReviewState);
    expect(omitted.threadActions).toEqual([]);
    expect(invented.priorReviewState).toEqual(priorReviewState);
    expect(invented.threadActions).toEqual([]);
  });

  it("uses the selected verifier model for user replies", async () => {
    const verifierProvider: ProviderConfig = {
      ...provider,
      id: "fast-verifier",
      model: "fast-verifier-model",
    };
    const models: string[] = [];

    const result = await runVerifier({
      verifierProvider,
      observeModel: (model) => {
        models.push(model);
      },
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "fixed",
            response: "Resolved.",
          },
        ],
      },
    });

    expect(models).toEqual(["fast-verifier-model"]);
    expect(result.providerModels).toEqual(["fast-verifier-model"]);
  });

  it("runs the verifier without repository read tools", async () => {
    let observedPrompt = "";
    let observedBuiltinTools: unknown;
    let observedRuntimeTools: unknown;

    await runVerifier({
      config: {
        ...config,
        limits: {
          diffManifest: {
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 262_144,
            condensedMaxEstimatedTokens: 65_536,
            toolResponseMaxBytes: 4096,
          },
        },
      },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
      observeRun: (run) => {
        observedBuiltinTools = run.builtinTools;
        observedRuntimeTools = run.runtimeTools;
      },
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
    });

    expect(observedPrompt).toContain("Available tools: none.");
    expect(observedPrompt).not.toContain("Available tools: read");
    expect(observedPrompt).not.toContain("pipr_read_diff");
    expect(observedPrompt).toContain("Do not request repository, filesystem, network");
    expect(observedBuiltinTools).toEqual([]);
    expect(observedRuntimeTools).toBeUndefined();
  });

  it("passes the supplied stable run id to verifier input", async () => {
    let observedPrompt = "";

    await runVerifier({
      runId: "pipr-stable-verifier-run",
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
    });

    expect(observedPrompt).toContain('"runId": "pipr-stable-verifier-run"');
  });

  it("projects the Diff Manifest once and caps every verifier attempt at two minutes", async () => {
    const sentinel = "verifier-manifest-sentinel";
    let observedPrompt = "";
    let observedTimeout: number | undefined;

    await runVerifier({
      diffManifest: { ...diffManifest, baseSha: sentinel },
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
      observePrompt: (prompt) => {
        observedPrompt = prompt;
      },
      observeRun: (run) => {
        observedTimeout = run.timeoutSeconds;
      },
    });

    expect(observedPrompt.split(sentinel)).toHaveLength(2);
    expect(observedTimeout).toBe(120);
  });

  it("matches verifier candidates to the currently commented finding head", async () => {
    const result = await runVerifier({
      mode: { kind: "synchronize" },
      priorReviewState: {
        ...priorReviewState,
        findings: [
          {
            ...(priorReviewState.findings[0] as PriorReviewState["findings"][number]),
            lastCommentedHeadSha: "new-thread-head",
          },
        ],
      },
      threadContexts: [
        threadContext,
        {
          ...threadContext,
          findingHeadSha: "new-thread-head",
          parentCommentId: "12",
          parentBody: "<!-- pipr:finding id=fnd_existing head=new-thread-head -->\nNew thread.",
          threadId: "thread-2",
          comments: [{ id: "12", body: "New thread.", authorLogin: "github-actions[bot]" }],
        },
      ],
      output: { findings: [{ id: "fnd_existing", status: "fixed" }] },
    });

    expect(result.threadActions).toEqual([
      expect.objectContaining({
        kind: "resolve",
        findingHeadSha: "new-thread-head",
        commentId: "12",
        threadId: "thread-2",
      }),
    ]);
  });

  it("does not pass already resolved threads to the verifier agent", async () => {
    let ranVerifierAgent = false;
    const result = await runVerifier({
      threadContexts: [{ ...threadContext, threadResolved: true }],
      observeRun: () => {
        ranVerifierAgent = true;
      },
      output: { findings: [{ id: "fnd_existing", status: "fixed", response: "Resolved." }] },
    });

    expect(ranVerifierAgent).toBe(false);
    expect(result.priorReviewState).toEqual(priorReviewState);
    expect(result.threadActions).toEqual([]);
  });

  it("ignores unknown output and replies to a different parent", async () => {
    const unknown = await runVerifier({
      output: { findings: [{ id: "fnd_existing", status: "unknown" }] },
    });
    const wrongParent = await runVerifier({
      parentCommentId: "999",
      output: {
        findings: [
          {
            id: "fnd_existing",
            status: "fixed",
            response: "Resolved.",
          },
        ],
      },
    });

    expect(unknown.threadActions).toEqual([]);
    expect(wrongParent.threadActions).toEqual([]);
  });
});

async function runVerifier(options: {
  output: unknown;
  config?: PiprConfig;
  mode?: { kind: "synchronize" };
  priorReviewState?: PriorReviewState;
  threadContexts?: InlineThreadContext[];
  parentCommentId?: string;
  respondWhenStillValid?: boolean;
  parentBody?: string;
  replyBody?: string;
  verifierProvider?: ProviderConfig;
  observeRun?: (run: Parameters<PiRunner>[0]) => void;
  observeModel?: (model: string) => void;
  observePrompt?: (prompt: string) => void;
  runId?: string;
  diffManifest?: DiffManifest;
}) {
  const piRunner: PiRunner = async (run) => {
    options.observeRun?.(run);
    options.observePrompt?.(run.prompt);
    options.observeModel?.(run.provider.model);
    return {
      stdout: JSON.stringify(options.output),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  };
  return await runInternalVerifier({
    workspace: process.cwd(),
    config: options.config ?? verifierConfig(options.verifierProvider),
    event,
    provider,
    verifierProvider: options.verifierProvider ?? provider,
    plan,
    diffManifest: options.diffManifest ?? diffManifest,
    priorReviewState: options.priorReviewState ?? priorReviewState,
    threadContexts: verifierThreadContexts(options),
    piRunner,
    mode: verifierMode(options),
    runId: options.runId ?? "pipr-test-verifier-run",
  });
}

function verifierConfig(verifierProvider: ProviderConfig | undefined): PiprConfig {
  if (!verifierProvider || verifierProvider.id === provider.id) {
    return config;
  }
  return {
    ...config,
    providers: [provider, verifierProvider],
    publication: {
      ...config.publication,
      autoResolve: {
        ...config.publication.autoResolve,
        model: verifierProvider.id,
      },
    },
  };
}

function verifierThreadContexts(options: {
  threadContexts?: InlineThreadContext[];
  parentBody?: string;
}): InlineThreadContext[] {
  return (
    options.threadContexts ?? [
      { ...threadContext, parentBody: options.parentBody ?? threadContext.parentBody },
    ]
  );
}

function verifierMode(options: {
  mode?: { kind: "synchronize" };
  parentCommentId?: string;
  replyBody?: string;
  respondWhenStillValid?: boolean;
}) {
  return (
    options.mode ?? {
      kind: "user-reply",
      reply: {
        commentId: "11",
        parentCommentId: options.parentCommentId ?? "10",
        body: options.replyBody ?? "The caller validates this earlier.",
        actor: "octo-dev",
      },
      respondWhenStillValid: options.respondWhenStillValid ?? true,
    }
  );
}
