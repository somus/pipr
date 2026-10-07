# ADR 0011: Finding outcome ledger

## Status

Accepted and implemented. Amends
[ADR 0009](./0009-protected-public-repository-run-observability.md).

## Context

Run Bundles explain what happened inside one execution, but nothing recorded what happened to a
finding after Pipr published it. Without outcomes, Pipr cannot measure which findings maintainers
fix, dismiss, or dispute, and cannot turn past reviews into evaluation data.

## Decision

Pipr records **Finding Outcomes**: append-only events keyed by the stable finding ID. Each event
carries the Review Run `workId`, the `executionId`, the reviewed head SHA, the trusted base config
hash, the model id, the producing agent name, and the finding's declared enum field values.

Event kinds are `proposed`, `dropped` (with a reason, including `cap`), `published`, `carried`,
`outdated`, `fixed`, `still-valid`, `resolved-by-human`, and `replied` (with the actor's
repository permission). Events are emitted where Pipr already decides them: finding selection,
comment publication, the verifier, and prior-state loading.

Outcomes persist on three surfaces:

- every Run Bundle carries a `ledger` artifact;
- the Main Review Comment state carries a bounded per-finding outcome history, so ephemeral CI runs
  continue a finding's history across pushes;
- webhook deployments append events to a `finding_events` table with the delivery store's
  retention policy.

Enum field values, agent names, model ids, config hashes, outcome kinds, and counts are
content-free and may appear in the public metadata plane. Paths, ranges, bodies, and diffs remain
diagnostic content.

`pipr runs stats` reports content-free rates grouped by field value, agent, model, and config
hash. `pipr runs export --dataset` requires a diagnostic identity and writes labeled evaluation
cases.

## Consequences

Learning signals depend on host capabilities. Hosts without thread resolution report
`resolved-by-human` as unavailable rather than inferring it. Reactions are not an outcome signal.

Outcome aggregation across repositories is meaningful only where repositories declare the same
field vocabulary.

The Main Review Comment state moved to a new format to carry outcome history, capped at 24,000
compressed characters to fit the smallest host comment limit. State in the earlier format is
ignored once, so the first review after upgrading starts without prior findings.
