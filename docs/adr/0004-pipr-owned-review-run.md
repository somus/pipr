# Pipr-owned Review Run

Status: Accepted

The default `pipr.review()` recipe calls the Pipr-owned Review Run through `ctx.change.diffManifest()` and `ctx.pi.run()`. It runs a canonical findings agent, merges any shards, then runs one summary agent with the scoped manifest and every merged candidate finding. The TypeScript config does not expose diff creation or review validation as userland blocks.

The Review Run owns:

- build the Diff Manifest from local git state
- run Pi with the selected agent and provider
- perform the single repair pass for invalid agent JSON
- validate built-in output against `core/inline-findings`, `core/summary`, or `core/pr-review`
- shard custom schemas rooted at `{ inlineFindings: [...] }` when each item contains the canonical finding fields, preserve extra item metadata, deduplicate by anchor plus body, and reparse the merged result
- return a validated review for comment rendering

Diff creation and review validation are internal to the runtime in the MVP. This keeps TypeScript tasks from bypassing the deterministic safety checks needed before Main Review Comment and Inline Review Comment publication.

Tasks may compose around the Review Run. Manual full-review agents can use `core/pr-review`; findings-only agents can use `core/inline-findings` or a compatible custom root schema. Summary-only and arbitrary custom schemas are not sharded. Pull request event runs may select multiple tasks; Pipr computes the Diff Manifest once and runs selected tasks in parallel with isolated task state.

## Durability guarantee

Pipr gives each selected Review Run a stable id derived from the repository, change number, base and head SHAs, trusted config identity, selected task names, and command source when present. The runtime exposes that id as `ctx.run.id` and passes it to Pi agent prompt and tool contexts.

The id identifies the review work, not the process attempt. If a GitHub Action reruns for the same change and config, Pipr recomputes the same id. Pipr does not cache or resume Pi calls in the MVP; failed process attempts rerun agents from the same reconstructed inputs.
