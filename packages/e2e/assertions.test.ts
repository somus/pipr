#!/usr/bin/env bun
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderActActionMetadata } from "./action-metadata.ts";
import {
  assertActCondensedFixture,
  assertActFullFixture,
  assertActOrchestratorFixture,
  assertCondensedPiWorkspace,
} from "./assertions.ts";
import { prepareScenarioWorktree, scenarios } from "./scenarios.ts";

const headSha = "head-sha";

test("validates Action scenario assertions", async () => {
  await assertDryRunScenarioPreparation();
  await assertActionMetadataRendering();
  await assertDockerE2eRunsActSmoke();
  await assertActBindsPreparedGitWorkspace();
  await assertCondensedWorkspaceTelemetry();

  await assertActFullFixture(validFullFixture(), headSha);
  expect(() => assertActCondensedFixture(validCondensedFixture())).not.toThrow();
  expect(() => assertActOrchestratorFixture(validOrchestratorFixture())).not.toThrow();

  for (const [message, fixture] of fullFailureFixtures()) {
    await expectFailure(message, fixture);
  }
  for (const [message, fixture] of condensedFailureFixtures()) {
    expectCondensedFailure(message, fixture);
  }
  for (const [message, fixture] of orchestratorFailureFixtures()) {
    expectOrchestratorFailure(message, fixture);
  }
});

async function assertDryRunScenarioPreparation(): Promise<void> {
  expect(scenarios["dry-run"].baseSample).toBeTruthy();
  const prepared = await prepareScenarioWorktree(scenarios["dry-run"]);
  try {
    expect(prepared.baseSha).not.toBe(prepared.headSha);
  } finally {
    prepared.cleanup();
  }
}

async function assertDockerE2eRunsActSmoke(): Promise<void> {
  const source = await Bun.file(new URL("../../scripts/docker-e2e.ts", import.meta.url)).text();
  expect(source).toContain('"check:actions", "dry-run"');
  expect(source).toContain('PIPR_SKIP_ACTION_IMAGE_BUILD: "1"');
}

async function assertActBindsPreparedGitWorkspace(): Promise<void> {
  const source = await Bun.file(new URL("./run.ts", import.meta.url)).text();
  expect(source).toContain('"--bind"');
}

async function assertActionMetadataRendering(): Promise<void> {
  const source = await Bun.file(new URL("../../action.yml", import.meta.url)).text();
  const image = "pipr-action:test";
  const rendered = renderActActionMetadata(source, image);
  const expected = source.replace(
    /^(\s*)image:\s*docker:\/\/\S+(?:\s+#.*)?\s*$/m,
    `$1image: docker://${image}`,
  );
  const fixtureRendered = renderActActionMetadata(source, image, {
    entrypointScript: "/opt/pipr/packages/e2e/action-fixture.ts",
  });

  expect(rendered).toBe(expected);
  expect(rendered).toContain("image: docker://pipr-action:test");
  expect(rendered).not.toContain("image: docker://ghcr.io/somus/pipr:main");
  expect(rendered).toContain("inputs:");
  expect(rendered).toContain("outputs:");
  expect(rendered).toContain("args:");
  expect(rendered).toContain("    - host-run");
  expect(rendered).not.toContain("    - action");
  expect(fixtureRendered).toContain("entrypoint: /usr/local/bin/bun");
  expect(fixtureRendered).toContain("    - /opt/pipr/packages/e2e/action-fixture.ts");
  expect(fixtureRendered).toContain("    - host-run");
}

async function assertCondensedWorkspaceTelemetry(): Promise<void> {
  const telemetryPath = await mkdtemp(path.join(os.tmpdir(), "pipr-e2e-telemetry-"));
  const workspace = path.join(telemetryPath, "removed-workspace");
  try {
    const attempts = [
      ["primary-first", "deepseek/deepseek-v4-pro"],
      ["primary-retry", "deepseek/deepseek-v4-pro"],
      ["fallback", "deepseek/deepseek-v4-fallback"],
      ["fallback-repair", "deepseek/deepseek-v4-fallback"],
    ] as const;
    for (const [index, [id, providerId]] of attempts.entries()) {
      await Bun.write(
        path.join(telemetryPath, `${id}.jsonl`),
        `${JSON.stringify({
          id,
          phase: "start",
          time: index * 2 + 1,
          promptKind: "condensed",
          providerId,
          workspace,
          home: `/tmp/home-${id}`,
          sessionDir: `/tmp/session-${id}`,
          tmp: `/tmp/tmp-${id}`,
        })}\n${JSON.stringify({ id, phase: "end", time: index * 2 + 2, promptKind: "condensed" })}\n`,
      );
    }

    await mkdir(workspace);
    await expect(assertCondensedPiWorkspace(telemetryPath)).rejects.toThrow(
      "shared Pi workspace was not cleaned up",
    );
    await rm(workspace, { recursive: true });
    await expect(assertCondensedPiWorkspace(telemetryPath)).resolves.toBeUndefined();
  } finally {
    await rm(telemetryPath, { recursive: true, force: true });
  }
}

async function expectFailure(message: string, fixture: PublicationFixture): Promise<void> {
  try {
    await assertActFullFixture(fixture, headSha);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`expected failure '${message}'`);
}

function expectCondensedFailure(message: string, fixture: PublicationFixture): void {
  expect(() => assertActCondensedFixture(fixture)).toThrow(message);
}

function expectOrchestratorFailure(message: string, fixture: PublicationFixture): void {
  expect(() => assertActOrchestratorFixture(fixture)).toThrow(message);
}

type ReviewCommentPayload = {
  path?: string;
  commit_id?: string;
  line?: number;
  side?: string;
  body?: string;
};

type PublicationFixture = {
  issueComments?: Array<{ body?: string }>;
  reviewCommentPayloads?: ReviewCommentPayload[];
  reviewComments?: ReviewCommentPayload[];
  droppedFindings?: Array<{ reason?: string }>;
};

function validFullFixture(): PublicationFixture {
  return {
    issueComments: [{ body: fullMainCommentBody() }],
    reviewCommentPayloads: [validInlinePayload()],
    droppedFindings: [
      droppedFinding(),
      droppedFinding(),
      droppedFinding("duplicate finding fingerprint"),
    ],
  };
}

function droppedFinding(reason = "finding path does not match range path"): { reason: string } {
  return { reason };
}

function fullFailureFixtures(): Array<[string, PublicationFixture]> {
  return [
    [
      "main comment marker missing",
      { ...validFullFixture(), issueComments: [{ body: "manual comment" }] },
    ],
    ["expected 1 inline payload, got 0", { ...validFullFixture(), reviewCommentPayloads: [] }],
    [
      "unexpected inline commit_id",
      {
        ...validFullFixture(),
        reviewCommentPayloads: [{ ...validInlinePayload(), commit_id: "stale-head" }],
      },
    ],
    [
      "inline marker missing",
      {
        ...validFullFixture(),
        reviewCommentPayloads: [{ ...validInlinePayload(), body: "missing marker" }],
      },
    ],
    [
      "secondary section missing",
      {
        ...validFullFixture(),
        issueComments: [
          { body: fullMainCommentBody().replace("Full fixture secondary section\n", "") },
        ],
      },
    ],
    [
      "path-missed task was selected",
      {
        ...validFullFixture(),
        issueComments: [{ body: `${fullMainCommentBody()}\npipr/docs-only` }],
      },
    ],
    [
      "unexpected range/path drop count",
      {
        ...validFullFixture(),
        droppedFindings: [droppedFinding("duplicate finding fingerprint")],
      },
    ],
    [
      "unexpected range/path drop count",
      { ...validFullFixture(), droppedFindings: [droppedFinding()] },
    ],
    [
      "unexpected duplicate finding drop count",
      {
        ...validFullFixture(),
        droppedFindings: [
          droppedFinding(),
          droppedFinding(),
          droppedFinding("some other drop reason"),
        ],
      },
    ],
    [
      "out-of-scope finding was published",
      {
        ...validFullFixture(),
        issueComments: [
          { body: `${fullMainCommentBody()}\nOut-of-scope act path should not publish.` },
        ],
      },
    ],
  ];
}

function fullMainCommentBody(): string {
  return [
    mainMarker(),
    "",
    "# Pipr Review",
    "",
    "Full fixture secondary section",
    "",
    "Fake Pi reviewed the act full-flow fixture.",
    "- Full-flow act reached inline publication.",
  ].join("\n");
}

function validCondensedFixture(): PublicationFixture {
  return {
    issueComments: [
      {
        body: `${mainMarker()}\n\nCondensed act fixture reached Pi after runtime tools passed.`,
      },
    ],
    reviewCommentPayloads: [],
    reviewComments: [],
  };
}

function condensedFailureFixtures(): Array<[string, PublicationFixture]> {
  return [
    [
      "condensed summary missing",
      { ...validCondensedFixture(), issueComments: [{ body: mainMarker() }] },
    ],
    [
      "unexpected inline payloads: expected 0, got 1",
      { ...validCondensedFixture(), reviewCommentPayloads: [validInlinePayload()] },
    ],
  ];
}

function validOrchestratorFixture(): PublicationFixture {
  return {
    issueComments: [
      {
        body: [
          mainMarker(),
          "",
          "Orchestrated review combined correctness, security, and tests specialist outputs.",
          "",
          "## Custom labels",
          "",
          "### medium",
          "",
          "- Orchestrator custom schema mapped a labeled finding into core inline output.",
        ].join("\n"),
      },
    ],
    reviewCommentPayloads: [
      {
        body: [
          "<!-- pipr:finding id=fnd_fixture head=head-sha -->",
          "Severity: medium",
          "",
          "Orchestrator custom schema mapped a labeled finding into core inline output.",
        ].join("\n"),
      },
    ],
  };
}

function orchestratorFailureFixtures(): Array<[string, PublicationFixture]> {
  return [
    [
      "orchestrated summary missing",
      { ...validOrchestratorFixture(), issueComments: [{ body: mainMarker() }] },
    ],
    [
      "custom severity label missing",
      {
        ...validOrchestratorFixture(),
        issueComments: [
          {
            body:
              validOrchestratorFixture().issueComments?.[0]?.body?.replace(
                "- Orchestrator custom schema mapped a labeled finding into core inline output.",
                "",
              ) ?? "",
          },
        ],
      },
    ],
  ];
}

function validInlinePayload(): NonNullable<PublicationFixture["reviewCommentPayloads"]>[number] {
  return {
    path: "packages/e2e/fixtures/act/project/sample.ts",
    commit_id: headSha,
    line: 2,
    side: "RIGHT",
    body: "<!-- pipr:finding id=fnd_fixture head=head-sha -->",
  };
}

function mainMarker(): string {
  return "<!-- pipr:main-comment change=1 version=1 state=eyJ2ZXJzaW9uIjoxLCJyZXZpZXdlZEhlYWRTaGEiOiJoZWFkLXNoYSIsImZpbmRpbmdzIjpbXX0 -->";
}
