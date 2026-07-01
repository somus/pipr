# Pipr-owned Comment Publishing

Status: Accepted

Review tasks produce one final typed output per selected run. They do not call code host APIs directly.

Comment Publishing:

- requires exactly one final output call per selected run: `ctx.comment(...)` for review publication or `ctx.command.reply(...)` for command response publication
- renders one deterministic Main Review Comment body from review output
- renders and publishes command response output as a normal pull request issue comment keyed to the source command comment
- leaves multi-agent or multi-task summary composition to user configuration
- verifies the current change request head SHA before any write
- upserts the Main Review Comment by hidden marker and stores Pipr-owned review state on that marker
- caps Inline Review Comments only when `publication.maxInlineComments` is configured
- dedupes Inline Review Comments by stable finding id, reviewed head SHA, and Pipr-owned same-head location overlap
- passes open prior finding locations into rerun prompts so reviewers can keep prior finding ids without resolving by omission
- resolves fixed prior findings only through explicit verifier output and thread actions
- replies to stale GitHub Inline Review Comments with the resolving commit link and resolves their review threads when the verifier marks prior findings fixed
- leaves provider-specific inline comment payload mapping to the code host adapter
- reports comment publishing failures in metadata and fails the Action for the MVP

The runtime controls validation, stale-head checks, marker dedupe, and API writes while user configuration owns final comment composition. The GitHub adapter maps inline findings to GitHub `line`, `side`, `start_line`, and `start_side`; future adapters can map the same neutral inline items to their native diff position model.
