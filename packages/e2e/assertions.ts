export type ActAssertionMode = "full" | "condensed" | "orchestrator";

type ReviewCommentPayload = {
  path?: string;
  commit_id?: string;
  line?: number;
  side?: string;
  body?: string;
};

type PublicationFixture = {
  headSha?: string;
  issueComments?: Array<{ body?: string }>;
  reviewCommentPayloads?: ReviewCommentPayload[];
  reviewComments?: ReviewCommentPayload[];
  droppedFindings?: Array<{ reason?: string; finding?: { body?: string } }>;
};

type TelemetryEvent = {
  phase?: string;
  promptKind?: string;
  time: number;
};

const mainCommentMarkerPrefix = "<!-- pipr:main-comment change=1 version=1 state=";

export async function assertActFixture(options: {
  fixturePath: string;
  mode: ActAssertionMode;
  telemetryPath?: string;
}): Promise<void> {
  const fixture = (await Bun.file(options.fixturePath).json()) as PublicationFixture;
  if (options.mode === "full") {
    assert(typeof fixture.headSha === "string", "full assertion requires expected head SHA");
    await assertActFullFixture(fixture, fixture.headSha, options.telemetryPath);
    return;
  }
  if (options.mode === "condensed") {
    assertActCondensedFixture(fixture);
    return;
  }
  assertActOrchestratorFixture(fixture);
}

export async function assertActFullFixture(
  fixture: PublicationFixture,
  expectedHeadSha: string,
  telemetryPath?: string,
): Promise<void> {
  assertFullMainComment(readOnlyMainComment(fixture));
  assertPathScopedDropReasons(fixture);
  assertNoOutOfScopeFinding(fixture);
  assertInlinePayload(readOnlyInlinePayload(fixture), expectedHeadSha);
  if (telemetryPath) {
    await assertParallelPiCalls(telemetryPath);
  }
}

export function assertActCondensedFixture(fixture: PublicationFixture): void {
  const mainComment = readOnlyMainComment(fixture);
  assert(mainComment.includes(mainCommentMarkerPrefix), "main comment marker missing");
  assert(
    mainComment.includes("Condensed act fixture reached Pi after runtime tools passed."),
    "condensed summary missing",
  );
  assertEqual((fixture.reviewCommentPayloads ?? []).length, 0, "unexpected inline payloads");
  assertEqual((fixture.reviewComments ?? []).length, 0, "unexpected inline comments");
}

export function assertActOrchestratorFixture(fixture: PublicationFixture): void {
  const mainComment = readOnlyMainComment(fixture);
  assert(mainComment.includes(mainCommentMarkerPrefix), "main comment marker missing");
  assert(
    mainComment.includes(
      "Orchestrated review combined correctness, security, and tests specialist outputs.",
    ),
    "orchestrated summary missing",
  );
  assert(mainComment.includes("## Custom labels"), "custom labels section missing");
  assert(mainComment.includes("### medium"), "custom severity group missing");
  assert(
    mainComment.includes(
      "- Orchestrator custom schema mapped a labeled finding into core inline output.",
    ),
    "custom severity label missing",
  );
  const inlinePayloads = fixture.reviewCommentPayloads ?? [];
  assertEqual(inlinePayloads.length, 1, "unexpected inline payloads");
  const inlineBody = inlinePayloads[0]?.body ?? "";
  assert(
    inlineBody.includes(
      "Orchestrator custom schema mapped a labeled finding into core inline output.",
    ),
    "orchestrator inline missing",
  );
  assert(inlineBody.includes("Severity: medium"), "custom severity missing from inline finding");
}

function readOnlyMainComment(fixture: PublicationFixture): string {
  const issueComments = fixture.issueComments ?? [];
  assertEqual(issueComments.length, 1, "unexpected main comment count");
  const body = issueComments[0]?.body;
  assert(typeof body === "string", "main comment body missing");
  return body;
}

function assertFullMainComment(body: string): void {
  assert(body.includes(mainCommentMarkerPrefix), "main comment marker missing");
  assert(body.includes("Full fixture secondary section"), "secondary section missing");
  assert(!body.includes("pipr/docs-only"), "path-missed task was selected");
  assert(
    !body.includes("Out-of-scope act path should not publish."),
    "out-of-scope finding was published",
  );
}

function assertPathScopedDropReasons(fixture: PublicationFixture): void {
  const pathScopedDrops = (fixture.droppedFindings ?? []).filter(
    (drop) => drop.reason === "finding path is outside configured paths",
  );
  const duplicateDrops = (fixture.droppedFindings ?? []).filter(
    (drop) => drop.reason === "duplicate finding fingerprint",
  );
  assertEqual(pathScopedDrops.length, 2, "unexpected path-scoped drop count");
  assertEqual(duplicateDrops.length, 1, "unexpected duplicate finding drop count");
  assertEqual((fixture.droppedFindings ?? []).length, 3, "unexpected total dropped finding count");
}

function assertNoOutOfScopeFinding(fixture: PublicationFixture): void {
  const publishedText = [
    ...(fixture.issueComments ?? []).map((comment) => comment.body ?? ""),
    ...(fixture.reviewCommentPayloads ?? []).map((comment) => comment.body ?? ""),
    ...(fixture.reviewComments ?? []).map((comment) => comment.body ?? ""),
  ].join("\n");
  assert(
    !publishedText.includes("Out-of-scope act path should not publish."),
    "out-of-scope finding was published",
  );
}

function readOnlyInlinePayload(fixture: PublicationFixture): ReviewCommentPayload {
  const reviewCommentPayloads = fixture.reviewCommentPayloads ?? [];
  assert(
    reviewCommentPayloads.length === 1,
    `expected 1 inline payload, got ${reviewCommentPayloads.length}`,
  );
  const inline = reviewCommentPayloads[0];
  assert(inline !== undefined, "inline payload missing");
  return inline;
}

function assertInlinePayload(inline: ReviewCommentPayload, expectedHeadSha: string): void {
  assert(inline.path === "packages/e2e/fixtures/act/project/sample.ts", "unexpected inline path");
  assert(inline.commit_id === expectedHeadSha, "unexpected inline commit_id");
  assert(inline.side === "RIGHT", "unexpected inline side");
  assert(typeof inline.line === "number" && inline.line > 0, "unexpected inline line");
  assert(inline.body?.includes("<!-- pipr:finding ") === true, "inline marker missing");
}

async function assertParallelPiCalls(telemetryPath: string): Promise<void> {
  const events = (
    await Promise.all(
      [...new Bun.Glob("*.jsonl").scanSync({ cwd: telemetryPath })].map(async (file) =>
        readTelemetryFile(`${telemetryPath}/${file}`),
      ),
    )
  ).flat();
  const fullStarts = events.filter(
    (event) => event.phase === "start" && event.promptKind === "full",
  );
  assert(fullStarts.length >= 2, `expected at least 2 full Pi calls, got ${fullStarts.length}`);
  assert(maxActiveCalls(events) >= 2, "task Pi calls did not overlap");
}

async function readTelemetryFile(path: string): Promise<TelemetryEvent[]> {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

function maxActiveCalls(events: TelemetryEvent[]): number {
  let active = 0;
  let maxActive = 0;
  for (const event of events.toSorted(
    (left, right) =>
      left.time - right.time ||
      (left.phase === "start" ? 0 : 1) - (right.phase === "start" ? 0 : 1),
  )) {
    if (event.phase === "start") {
      active += 1;
      maxActive = Math.max(maxActive, active);
    }
    if (event.phase === "end") {
      active -= 1;
    }
  }
  return maxActive;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message}: expected ${expected}, got ${actual}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
