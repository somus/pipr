# Pipr-owned Comment Publishing

Status: Accepted

Review tasks produce one final typed output per selected run. They do not call code host APIs directly.

Comment Publishing:

- requires exactly one final output call per selected run: `ctx.comment(...)` for review publication or `ctx.command.reply(...)` for command response publication
- renders one deterministic Main Review Comment body from review output
- renders and publishes command response output as a normal pull request issue comment keyed to the source command comment
- leaves multi-agent or multi-task summary composition to user configuration
- verifies the current change request head SHA before publication writes
- publishes inline comments and thread actions before upserting the Main Review Comment, so the stored review state is the publication watermark
- upserts the Main Review Comment by hidden marker and stores Pipr-owned review state on that marker only after required inline writes succeed
- caps Inline Review Comments only when `publication.maxInlineComments` is configured
- dedupes Inline Review Comments by stable finding id, reviewed head SHA, and Pipr-owned same-head location overlap
- passes open prior finding locations into rerun prompts so reviewers can keep prior finding ids without resolving by omission
- resolves fixed prior findings only through explicit verifier output and thread actions
- replies to stale GitHub Inline Review Comments with the resolving commit link and resolves their review threads when the verifier marks prior findings fixed
- leaves provider-specific inline comment payload mapping to the code host adapter
- reports comment publishing failures in metadata and fails the Action for the MVP

The runtime controls validation, stale-head checks, marker dedupe, and API writes while user configuration owns final comment composition. The GitHub adapter maps inline findings to GitHub `line`, `side`, `start_line`, and `start_side`; future adapters can map the same neutral inline items to their native diff position model.

## Retry and partial-publication behavior

Code host comments are the durability store for publication. The Main Review Comment marker stores Pipr-owned review state. Inline Review Comment and command response markers prove which writes Pipr owns and which findings or responses were actually posted.

Pipr makes at most three attempts for rate-limited and transient operations. It honors provider retry headers within a bounded wait budget. Read operations and provider-native idempotent upserts can retry directly. A comment create can retry only after reloading provider state and reconciling the exact Pipr marker, which prevents an accepted write with a lost response from producing a duplicate.

On rerun, Pipr reloads its owned comments, skips already posted inline markers, posts missing Inline Review Comments, completes thread actions, and then updates the Main Review Comment. If a required inline publication still fails, the Action fails without advancing the main-comment review state, and a later rerun continues from the inline markers already present on the code host.

Pipr checks the current change request head SHA before starting publication writes. If the head already differs, a review computed for an old head fails without updating the Main Review Comment, posting Inline Review Comments, command responses, or thread actions. This is a pre-publication guard, not an atomic lock across the later code host API sequence; marker dedupe keeps retries safe if a race or partial failure occurs.
