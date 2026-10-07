import type {
  InlinePublicationItem,
  InlineThreadContext,
  ThreadAction,
} from "../../publication/types.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  extractResolvedFindingMarkerRecords,
  extractVerifierResponseMarkers,
  inlineFindingMarker,
  mainCommentMarker,
  parseInlineFindingMarker,
} from "../../review/comment-markers.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import { inlinePublicationDecision } from "../../review/inline-publication-policy.js";
import { applyNativeThreadResolutions } from "../../review/prior-state.js";
import {
  extractReviewProgressToken,
  ReviewProgressSupersededError,
} from "../../review/progress.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { commandResponseBody, commandStatusText, threadActionReply } from "../publication.js";
import type { CodeHostComments, CodeHostPublication } from "../types.js";
export type OwnedMainComment = { id: string; body?: string };
export type OwnedInlineComment = {
  body: string;
  location?: InlinePublicationLocation;
  /** Native thread resolution; undefined when the host reports no native thread state. */
  resolved?: boolean;
};
export type LoadedPublicationState = {
  main?: OwnedMainComment;
  inline: readonly OwnedInlineComment[];
  threads: readonly InlineThreadContext[];
};

export interface PublicationDriver<Prepared> {
  readonly provider: string;
  /**
   * Whether owned inline state costs reads beyond the main comment. Such hosts read the main comment first, so a first
   * review, which has no prior state, loads no inline comments or threads.
   */
  readonly inlineStateNeedsExtraReads?: boolean;
  prepare(change: ChangeRequestEventContext, expectedHeadSha: string): Promise<Prepared>;
  assertCurrent(prepared: Prepared, expectedHeadSha: string): Promise<void>;
  /**
   * Loads owned comments in one snapshot. Threads keep only owned replies unless
   * `allReplies` is set.
   */
  loadOwnedState(
    prepared: Prepared,
    mainMarker: string,
    options?: { allReplies?: boolean },
  ): Promise<LoadedPublicationState>;
  loadOwnedThreads?(
    prepared: Prepared,
    actions: readonly ThreadAction[],
  ): Promise<readonly InlineThreadContext[]>;
  loadOwnedMain(prepared: Prepared, mainMarker: string): Promise<OwnedMainComment | undefined>;
  /** Creates or updates a top-level main or command response comment. */
  upsertComment(
    prepared: Prepared,
    existing: OwnedMainComment | undefined,
    body: string,
    kind: "main" | "command",
  ): Promise<{ id: string; action: "created" | "updated" }>;
  inlineLocation(prepared: Prepared, item: InlinePublicationItem): InlinePublicationLocation;
  createInline(prepared: Prepared, item: InlinePublicationItem): Promise<void>;
  loadOwnedCommand(prepared: Prepared, marker: string): Promise<OwnedMainComment | undefined>;
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

/** Reads prior Pipr comments through the same owned-state loaders publication uses. */
export function createCommentsReader<Prepared>(
  driver: PublicationDriver<Prepared>,
): Required<CodeHostComments> {
  const prepare = (change: ChangeRequestEventContext) =>
    driver.prepare(change, change.change.head.sha);
  return {
    async loadPriorMainComment({ change }) {
      return (await driver.loadOwnedMain(await prepare(change), mainCommentMarker))?.body;
    },
    async loadPriorReviewState({ change }) {
      const prepared = await prepare(change);
      if (driver.inlineStateNeedsExtraReads) {
        const main = await driver.loadOwnedMain(prepared, mainCommentMarker);
        if (!extractPriorReviewState(main?.body, change.change.number)) return undefined;
      }
      const state = await driver.loadOwnedState(prepared, mainCommentMarker);
      const prior = extractPriorReviewState(state.main?.body, change.change.number);
      if (!prior) return undefined;
      const bodies = [
        ...state.inline.map((item) => item.body),
        ...state.threads.flatMap((thread) =>
          thread.comments.flatMap((comment) =>
            comment.id === thread.parentCommentId ? [] : [comment.body],
          ),
        ),
      ];
      return applyNativeThreadResolutions(
        applyResolvedFindingMarkers(applyInlineFindingMarkers(prior, bodies), bodies),
        state.inline.flatMap(({ body, resolved }) => {
          const marker = resolved === undefined ? undefined : parseInlineFindingMarker(body);
          return marker && resolved !== undefined
            ? [{ findingId: marker.id, findingHeadSha: marker.head, resolved }]
            : [];
        }),
      );
    },
    async loadInlineThreadContexts({ change }) {
      const state = await driver.loadOwnedState(await prepare(change), mainCommentMarker, {
        allReplies: true,
      });
      return [...state.threads];
    },
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
  const main = await driver.upsertComment(prepared, currentMain, options.plan.mainComment, "main");
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
  let main = await driver.loadOwnedMain(prepared, mainCommentMarker);
  if (progressWasSuperseded(main, options.expectedToken)) return { status: "superseded" as const };
  await driver.assertCurrent(prepared, options.reviewedHeadSha);
  main = await driver.loadOwnedMain(prepared, mainCommentMarker);
  if (progressWasSuperseded(main, options.expectedToken)) return { status: "superseded" as const };
  if (!main && options.expectedToken) return { status: "superseded" as const };
  const result = await driver.upsertComment(prepared, main, options.renderBody(main?.body), "main");
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
  return driver.upsertComment(prepared, existing, response.body, "command");
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
    : (await driver.loadOwnedState(prepared, mainCommentMarker)).threads;
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
    item.resolved || !item.location || !parseInlineFindingMarker(item.body) ? [] : [item.location],
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
