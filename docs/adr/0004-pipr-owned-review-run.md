# Pipr-owned Review Run

Status: Accepted

The default `pipr.review()` recipe calls the Pipr-owned Review Run through `ctx.change.diffManifest()` and `ctx.pi.run()`. The TypeScript config does not expose diff creation or review validation as userland blocks.

The Review Run owns:

- build the Diff Manifest from local git state
- run Pi with the selected reviewer agent and provider
- perform the single repair pass for invalid reviewer JSON
- validate `PrReview` output against the Pipr-owned `core/pr-review` schema and Diff Manifest ranges
- return a validated review for comment rendering

Diff creation and review validation are internal to the runtime in the MVP. This keeps TypeScript tasks from bypassing the deterministic safety checks needed before Main Review Comment and Inline Review Comment publication.

Tasks may compose around the Review Run, but model-facing inline review must use the Pipr-owned `core/pr-review` schema when it wants Inline Review Comments. Pull request event runs may select multiple tasks; Pipr computes the Diff Manifest once and runs selected tasks in parallel with isolated task state.
