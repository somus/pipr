# ADR 0010: Durable harness in an agent worker

## Status

Accepted. Amends [ADR 0001](./0001-pipr-owns-pr-runtime-pi-owns-agent-execution.md) and
[ADR 0002](./0002-docker-action-with-read-only-pi-workspace.md).

## Context

Pipr ran every agent attempt as a separate `pi` CLI process. Each attempt started with a cold
prompt cache, repair attempts re-sent the whole prompt, webhook retries reran finished model turns,
and run evidence had to be reconstructed by parsing the CLI's JSON event stream. Pi now ships
`@earendil-works/pi-durable`, a library harness whose conversations, model turns, tool calls, and
documents are committed to storage before they are visible.

The CLI process was also Pipr's security boundary: the Action supervisor sealed a read-only
workspace copy and started Pi as UID and GID `1000`.

## Decision

Pipr runs agents through `@earendil-works/pi-durable` inside an **Agent Worker**: a
`pipr agent-worker` process that the supervisor starts with the same sealed sandbox and, when the
supervisor is root, the same `su-exec 1000:1000` identity drop. The worker and supervisor exchange
Zod-validated JSON messages over stdio. The worker receives only the selected model API key; it
never receives code host tokens, publication credentials, or diagnostic identities.

The worker installs only Pipr-owned tools: path-scoped `read`, `grep`, `find`, and `ls` over the
sealed workspace, and the Pipr Diff Read Tools. Plugin tools execute in the supervisor and are
reached through the worker message channel. All Pipr tools are read-only and declared replay-safe.
The harness `bash`, `write`, and `edit` tools are never installed.

Each worker owns one **Conversation Store**. Webhook deployments keep one store per change request
under the run store directory, so a retried delivery resumes committed work through stable request
identities. A recorded failure is never replayed: repeating a failed request calls the model again.
When a worker crashes or the supervisor kills it after a timeout, its replacement aborts the
unfinished work in the shared store instead of resuming it, so one bad run cannot take down each
successor. Action and local runs use a temporary store that is exported into the Run Bundle and
then removed.

`ctx.pi.run()` keeps Pipr's orchestration: shards, fallbacks, and the agent-run budget. One
invalid-output repair is sent as a follow-up input in the same conversation. Transient provider
retries use the harness retry policy. `ctx.pi.all()` forks parallel agents from a shared parent
conversation that holds the changed-code context, so siblings share a provider prompt-cache
prefix.

## Consequences

The Docker image no longer installs the `pi` CLI. Image verification runs
`pipr agent-worker --help` and `pipr host-run --help`. The Pi CLI flag contract test is replaced by
a harness contract test.

Pipr owns the read-only tool implementations instead of selecting Pi CLI built-ins. Tool scoping
and output bounds are Pipr-tested behavior.

A webhook store is single-process: one worker owns one store file at a time. Horizontal scaling
requires partitioning stores, for example by repository.
