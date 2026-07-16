import { lstat } from "node:fs/promises";

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
  workspace?: string;
  home?: string;
  sessionDir?: string;
  tmp?: string;
  providerId?: string;
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
    if (options.telemetryPath) {
      await assertCondensedPiWorkspace(options.telemetryPath);
    }
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
  assertFullFixtureDropReasons(fixture);
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

export async function assertCondensedPiWorkspace(telemetryPath: string): Promise<void> {
  const starts = (await readTelemetryEvents(telemetryPath))
    .filter((event) => event.phase === "start" && event.promptKind === "condensed")
    .toSorted((left, right) => left.time - right.time);
  assertEqual(starts.length, 4, "unexpected condensed Pi attempt count");
  assertEqual(
    starts.map((event) => event.providerId).join(","),
    [
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-fallback",
      "deepseek/deepseek-v4-fallback",
    ].join(","),
    "unexpected retry, fallback, and repair provider order",
  );
  const first = starts[0];
  assert(first !== undefined, "condensed Pi telemetry missing attempts");
  const workspace = requiredTelemetryPath(first, "workspace");
  const workspaces = starts.map((event) => requiredTelemetryPath(event, "workspace"));
  assertEqual(new Set(workspaces).size, 1, "Pi retry, fallback, or repair workspace changed");
  for (const key of ["home", "sessionDir", "tmp"] as const) {
    const paths = starts.map((event) => requiredTelemetryPath(event, key));
    assertEqual(new Set(paths).size, starts.length, `Pi attempts reused ${key}`);
  }
  assert(!(await pathExists(workspace)), "shared Pi workspace was not cleaned up");
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

function assertFullFixtureDropReasons(fixture: PublicationFixture): void {
  const rangePathDrops = (fixture.droppedFindings ?? []).filter(
    (drop) => drop.reason === "finding path does not match range path",
  );
  const duplicateDrops = (fixture.droppedFindings ?? []).filter(
    (drop) => drop.reason === "duplicate finding fingerprint",
  );
  assertEqual(rangePathDrops.length, 2, "unexpected range/path drop count");
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
  const events = await readTelemetryEvents(telemetryPath);
  const fullStarts = events.filter(
    (event) => event.phase === "start" && event.promptKind === "full",
  );
  assert(fullStarts.length >= 2, `expected at least 2 full Pi calls, got ${fullStarts.length}`);
  assert(
    new Set(fullStarts.map((event) => requiredTelemetryPath(event, "workspace"))).size >= 2,
    "parallel task Pi calls reused a workspace",
  );
  assert(maxActiveCalls(events) >= 2, "task Pi calls did not overlap");
}

async function readTelemetryEvents(telemetryPath: string): Promise<TelemetryEvent[]> {
  return (
    await Promise.all(
      [...new Bun.Glob("*.jsonl").scanSync({ cwd: telemetryPath })].map(async (file) =>
        readTelemetryFile(`${telemetryPath}/${file}`),
      ),
    )
  ).flat();
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

function requiredTelemetryPath(
  event: TelemetryEvent,
  key: "workspace" | "home" | "sessionDir" | "tmp",
): string {
  const value = event[key];
  assert(typeof value === "string" && value.length > 0, `Pi telemetry missing ${key}`);
  return value;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message}: expected ${expected}, got ${actual}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
