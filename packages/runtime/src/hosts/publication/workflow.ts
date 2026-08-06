import type { InlinePublicationItem, ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import { inlinePublicationDecision } from "../../review/inline-publication-policy.js";
import {
  extractInlineFindingMarkerRecords,
  extractResolvedFindingMarkerRecords,
  extractVerifierResponseMarkers,
  inlineFindingMarker,
} from "../../review/prior-state.js";
import {
  extractReviewProgressToken,
  ReviewProgressSupersededError,
} from "../../review/progress.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { commandResponseBody, commandStatusText, threadActionReply } from "../publication.js";
import type { CodeHostPublication, InlineThreadContext } from "../types.js";

export type OwnedMainComment = { id: string; body?: string };
export type OwnedInlineComment = {
  body: string;
  location?: InlinePublicationLocation;
  resolved: boolean;
};
export type LoadedPublicationState = {
  main?: OwnedMainComment;
  inline: readonly OwnedInlineComment[];
  threads: readonly InlineThreadContext[];
};

export interface PublicationDriver<Prepared> {
  readonly provider: string;
  prepare(change: ChangeRequestEventContext, expectedHeadSha: string): Promise<Prepared>;
  assertCurrent(prepared: Prepared, expectedHeadSha: string): Promise<void>;
  loadOwnedState(prepared: Prepared, mainMarker: string): Promise<LoadedPublicationState>;
  loadOwnedThreads?(
    prepared: Prepared,
    actions: readonly ThreadAction[],
  ): Promise<readonly InlineThreadContext[]>;
  loadOwnedMain(prepared: Prepared, mainMarker: string): Promise<OwnedMainComment | undefined>;
  upsertMain(
    prepared: Prepared,
    existing: OwnedMainComment | undefined,
    body: string,
  ): Promise<{ id: string; action: "created" | "updated" }>;
  inlineLocation(prepared: Prepared, item: InlinePublicationItem): InlinePublicationLocation;
  createInline(prepared: Prepared, item: InlinePublicationItem): Promise<void>;
  loadOwnedCommand(prepared: Prepared, marker: string): Promise<OwnedMainComment | undefined>;
  upsertCommand(
    prepared: Prepared,
    existing: OwnedMainComment | undefined,
    body: string,
  ): Promise<{ id: string; action: "created" | "updated" }>;
  replyThread(prepared: Prepared, action: ThreadAction, body: string): Promise<void>;
  resolveThread?(prepared: Prepared, action: ThreadAction): Promise<void>;
}

export function createPublicationWorkflow<Prepared>(
  driver: PublicationDriver<Prepared>,
): CodeHostPublication {
  return {
    publish: (options) => publishReview(driver, options),
    publishReviewProgress: (options) => publishProgress(driver, options),
    publishCommandResponse: (options) =>
      publishCommand(driver, { ...options, allowHeadDrift: false }),
    publishCommandStatus: (options) =>
      publishCommand(driver, {
        ...options,
        body: commandStatusText(options),
        allowHeadDrift: true,
      }),
    publishThreadActions: (options) => publishThreadActions(driver, options),
  };
}

async function publishReview<Prepared>(
  driver: PublicationDriver<Prepared>,
  options: Parameters<CodeHostPublication["publish"]>[0],
) {
  const expectedHeadSha = options.plan.metadata.reviewedHeadSha;
  const prepared = await driver.prepare(options.change, expectedHeadSha);
  await driver.assertCurrent(prepared, expectedHeadSha);
  const initial = await loadReviewState(driver, prepared, options.plan);
  assertProgressLease(initial.main, options.progressLease);
  await driver.assertCurrent(prepared, expectedHeadSha);

  const beforeWrite = async () => {
    await driver.assertCurrent(prepared, expectedHeadSha);
    if (!options.progressLease) return;
    const currentMain = await driver.loadOwnedMain(prepared, options.plan.mainMarker);
    assertProgressLease(currentMain, options.progressLease);
  };
  const inline = await publishInlineItems(
    driver,
    prepared,
    options.plan.inlineItems,
    initial,
    beforeWrite,
  );
  const resolution = await runThreadActions(
    driver,
    prepared,
    options.plan.threadActions,
    initial.threads,
    beforeWrite,
  );
  const partial = publicationPartial(options.plan.metadata, inline, resolution.errors);
  if (inline.errors.length > 0 && options.progressLease) {
    throw new PublicationError(`${driver.provider} inline comment publication failed`, partial);
  }

  await driver.assertCurrent(prepared, expectedHeadSha);
  const currentMain = await driver.loadOwnedMain(prepared, options.plan.mainMarker);
  assertProgressLease(currentMain, options.progressLease);
  const main = await driver.upsertMain(prepared, currentMain, options.plan.mainComment);
  if (inline.errors.length > 0) {
    throw new PublicationError(`${driver.provider} inline comment publication failed`, partial);
  }
  return {
    mainComment: {
      id: main.id,
      action: options.progressLease?.mainCommentAction ?? main.action,
    },
    ...partial,
  };
}

async function loadReviewState<Prepared>(
  driver: PublicationDriver<Prepared>,
  prepared: Prepared,
  plan: Parameters<CodeHostPublication["publish"]>[0]["plan"],
): Promise<LoadedPublicationState> {
  if (plan.inlineItems.length > 0 || plan.threadActions.length > 0) {
    return driver.loadOwnedState(prepared, plan.mainMarker);
  }
  return {
    main: await driver.loadOwnedMain(prepared, plan.mainMarker),
    inline: [],
    threads: [],
  };
}

async function publishProgress<Prepared>(
  driver: PublicationDriver<Prepared>,
  options: Parameters<NonNullable<CodeHostPublication["publishReviewProgress"]>>[0],
) {
  const prepared = await driver.prepare(options.change, options.reviewedHeadSha);
  await driver.assertCurrent(prepared, options.reviewedHeadSha);
  let main = await driver.loadOwnedMain(prepared, "pipr:main-comment");
  if (progressWasSuperseded(main, options.expectedToken)) return { status: "superseded" as const };
  await driver.assertCurrent(prepared, options.reviewedHeadSha);
  main = await driver.loadOwnedMain(prepared, "pipr:main-comment");
  if (progressWasSuperseded(main, options.expectedToken)) return { status: "superseded" as const };
  if (!main && options.expectedToken) return { status: "superseded" as const };
  const result = await driver.upsertMain(prepared, main, options.renderBody(main?.body));
  return { status: "published" as const, ...result };
}

async function publishCommand<Prepared>(
  driver: PublicationDriver<Prepared>,
  options: Parameters<NonNullable<CodeHostPublication["publishCommandResponse"]>>[0] & {
    body: string;
    allowHeadDrift: boolean;
  },
) {
  const expectedHeadSha = options.change.change.head.sha;
  const prepared = await driver.prepare(options.change, expectedHeadSha);
  if (!options.allowHeadDrift) await driver.assertCurrent(prepared, expectedHeadSha);
  const response = commandResponseBody({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
    body: options.body,
  });
  const existing = await driver.loadOwnedCommand(prepared, response.marker);
  if (!options.allowHeadDrift) await driver.assertCurrent(prepared, expectedHeadSha);
  return driver.upsertCommand(prepared, existing, response.body);
}

async function publishThreadActions<Prepared>(
  driver: PublicationDriver<Prepared>,
  options: Parameters<NonNullable<CodeHostPublication["publishThreadActions"]>>[0],
) {
  if (options.actions.length === 0) return { errors: [] };
  const prepared = await driver.prepare(options.change, options.reviewedHeadSha);
  await driver.assertCurrent(prepared, options.reviewedHeadSha);
  const threads = driver.loadOwnedThreads
    ? await driver.loadOwnedThreads(prepared, options.actions)
    : (await driver.loadOwnedState(prepared, "pipr:main-comment")).threads;
  await driver.assertCurrent(prepared, options.reviewedHeadSha);
  return runThreadActions(driver, prepared, options.actions, threads, () =>
    driver.assertCurrent(prepared, options.reviewedHeadSha),
  );
}

async function publishInlineItems<Prepared>(
  driver: PublicationDriver<Prepared>,
  prepared: Prepared,
  items: readonly InlinePublicationItem[],
  state: LoadedPublicationState,
  beforeWrite: () => Promise<void>,
) {
  const markers = new Set(
    extractInlineFindingMarkerRecords(state.inline.map((item) => item.body)).map(
      (item) => item.marker,
    ),
  );
  const locations = state.inline.flatMap((item) =>
    item.resolved || !item.location || extractInlineFindingMarkerRecords([item.body]).length === 0
      ? []
      : [item.location],
  );
  const errors: string[] = [];
  let posted = 0;
  let skipped = 0;
  for (const item of items) {
    let location: InlinePublicationLocation;
    try {
      location = driver.inlineLocation(prepared, item);
    } catch (error) {
      errors.push(errorMessage(error));
      continue;
    }
    const marker = inlineFindingMarker(item.findingId, item.reviewedHeadSha);
    if (
      inlinePublicationDecision({
        marker,
        location,
        existing: { markers, locations },
      }) === "skip"
    ) {
      skipped += 1;
      continue;
    }
    await beforeWrite();
    try {
      await driver.createInline(prepared, item);
      posted += 1;
      markers.add(marker);
      locations.push(location);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return { posted, skipped, errors };
}

async function runThreadActions<Prepared>(
  driver: PublicationDriver<Prepared>,
  prepared: Prepared,
  actions: readonly ThreadAction[],
  threads: readonly InlineThreadContext[],
  beforeWrite: () => Promise<void>,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  for (const action of actions) {
    errors.push(...(await runThreadAction(driver, prepared, action, threads, beforeWrite)));
  }
  return { errors };
}

async function runThreadAction<Prepared>(
  driver: PublicationDriver<Prepared>,
  prepared: Prepared,
  action: ThreadAction,
  threads: readonly InlineThreadContext[],
  beforeWrite: () => Promise<void>,
): Promise<string[]> {
  const thread = threadForAction(threads, action);
  if (!thread) return [`${driver.provider} thread not found for comment ${action.commentId}`];
  if (action.kind === "resolve" && thread.threadResolved) return [];
  const errors: string[] = [];
  const replyError = await runThreadReply(driver, prepared, action, thread, beforeWrite);
  if (replyError) errors.push(replyError);
  const resolveError = await runThreadResolution(driver, prepared, action, thread, beforeWrite);
  if (resolveError) errors.push(resolveError);
  return errors;
}

async function runThreadReply<Prepared>(
  driver: PublicationDriver<Prepared>,
  prepared: Prepared,
  action: ThreadAction,
  thread: InlineThreadContext,
  beforeWrite: () => Promise<void>,
): Promise<string | undefined> {
  if (threadReplyExists(thread, action)) return undefined;
  const reply = threadActionReply(action);
  const error = await attemptThreadWrite(beforeWrite, () =>
    driver.replyThread(prepared, action, reply.body),
  );
  if (!error) thread.comments.push({ id: "", body: reply.body });
  return error;
}

async function runThreadResolution<Prepared>(
  driver: PublicationDriver<Prepared>,
  prepared: Prepared,
  action: ThreadAction,
  thread: InlineThreadContext,
  beforeWrite: () => Promise<void>,
): Promise<string | undefined> {
  if (action.kind !== "resolve" || !driver.resolveThread) return undefined;
  const error = await attemptThreadWrite(beforeWrite, () =>
    driver.resolveThread?.(prepared, action),
  );
  if (!error) thread.threadResolved = true;
  return error;
}

function threadForAction(
  threads: readonly InlineThreadContext[],
  action: ThreadAction,
): InlineThreadContext | undefined {
  return action.threadId
    ? threads.find((thread) => thread.threadId === action.threadId)
    : threads.find((thread) => thread.parentCommentId === action.commentId);
}

function threadReplyExists(thread: InlineThreadContext, action: ThreadAction): boolean {
  const bodies = thread.comments.map((comment) => comment.body);
  if (action.kind === "resolve") {
    return extractResolvedFindingMarkerRecords(bodies).some(
      (record) => record.id === action.findingId && record.head === action.findingHeadSha,
    );
  }
  return extractVerifierResponseMarkers(bodies).has(
    `pipr:verifier-response:${action.findingId}:${action.responseKey}`,
  );
}

async function attemptThreadWrite(
  beforeWrite: () => Promise<void>,
  write: () => Promise<void> | undefined,
): Promise<string | undefined> {
  await beforeWrite();
  try {
    await write();
    return undefined;
  } catch (error) {
    if (error instanceof ReviewProgressSupersededError) throw error;
    return errorMessage(error);
  }
}

function assertProgressLease(
  main: OwnedMainComment | undefined,
  lease: Parameters<CodeHostPublication["publish"]>[0]["progressLease"],
): void {
  if (!lease) return;
  if (main?.id !== lease.mainCommentId || extractReviewProgressToken(main.body) !== lease.token) {
    throw new ReviewProgressSupersededError();
  }
}

function progressWasSuperseded(main: OwnedMainComment | undefined, token: string | undefined) {
  return token !== undefined && extractReviewProgressToken(main?.body) !== token;
}

function publicationPartial(
  metadata: Parameters<CodeHostPublication["publish"]>[0]["plan"]["metadata"],
  inline: { posted: number; skipped: number; errors: string[] },
  resolutionErrors: string[],
) {
  return {
    inlineComments: {
      posted: inline.posted,
      skipped: inline.skipped,
      failed: inline.errors.length,
    },
    metadata: {
      ...metadata,
      inlinePublicationErrors: inline.errors,
      inlineResolutionErrors: resolutionErrors,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
