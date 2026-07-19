# ADR 0007: Public results, command lifecycle, and webhook history

## Status

Accepted

## Context

The GitHub Action and local CLI previously serialized different V1 result shapes. Command-triggered model work also had no visible acknowledgement until publication finished, and the webhook queue retained delivery state without a safe result for inspection.

## Decision

Pipr defines one strict Pipr Result V2 schema in `@usepipr/sdk`. Runtime code converts hosted and local outcomes at one boundary, removes internal markers and identifiers, projects publication counts, and replaces thrown errors with public generic messages. Review and command results include bounded Review Run metadata; skipped runs don't invent a run.

Command execution reuses one Pipr-owned comment for `accepted`, `running`, and terminal state. Operational lifecycle writes may update after the reviewed head changes so Pipr can report `superseded`. Final model-generated command responses keep the live stale-head guard.

The optional webhook SQLite queue stores bounded Pipr Result V2 bodies. It keeps delivery rows for deduplication, omits individual bodies above 512 KiB, and evicts the oldest bodies when retained result JSON exceeds 32 MiB. `pipr webhook status` reads this local history; Pipr doesn't add a hosted control plane.

## Consequences

Action `result`, local `--json`, and webhook history share one breaking V2 contract with no V1 compatibility path. Consumers can validate one schema and don't receive Diff Manifests, publication plans, trusted-config identity, native comment IDs, credential metadata, or raw errors.
