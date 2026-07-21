# ADR 0008: Provider-neutral run observability

## Status

Accepted

## Context

Hosted reviews exposed human-readable CI logs and a bounded public Pipr Result, but neither surface retained enough evidence to explain slow model attempts, invalid-output repair, validation drops, or publication failures. Provider CI systems already supply access control, retention, and artifact storage, so adding a Pipr-hosted telemetry backend would duplicate those responsibilities.

Review Run IDs are deterministic work identities. A single process can execute the same work more than once, so that ID cannot also identify one execution trace.

## Decision

Every active hosted review, command, and verifier process starts a provider-neutral `RunRecorder` before native event parsing. The recorder uses one OpenTelemetry trace ID as its `executionId`; it records the existing Review Run ID as `workId` without changing `PiprResult`.

The SDK owns a strict versioned Run Bundle V1 schema. Runtime recorders write bounded JSONL spans and logs, metrics, redacted diagnostic artifacts, and an atomically finalized `run.json`. Capture and OTLP export fail open, and finalization plus OTLP flush has a two-second budget. OTLP uses HTTP/protobuf and carries content-free telemetry only.

Archive discovery remains separate from `CodeHostAdapter` through `RunArchiveSource`. GitHub Actions artifacts, GitLab job artifacts, Azure pipeline artifacts, Bitbucket Downloads, and filesystem stores retain their native authorization boundaries. `pipr runs list`, `show`, and `download` merge and validate those sources.

Bitbucket CI uses two storage paths because its documented public API cannot download native Pipelines artifacts. Generated pipelines always capture a native artifact and attempt a repository Downloads upload for automated retrieval. When the Downloads file is missing, Pipr reports `available-in-ci` only after finding the generated Pipr step marker through the documented Pipelines API, then links to the native pipeline.

Generated hosted CI uploads bundles after Pipr exits, including failed reviews. Local `pipr review` capture remains opt-in through `--trace`. Operational capture, storage, retention, quota, and OTLP settings remain runner flags or environment variables rather than repository review policy.

## Consequences

Pipr can diagnose completed runs deterministically and external coding agents can convert downloaded evidence into project-specific evals without an eval engine in Pipr Core. Diagnostic bundles are sensitive repository artifacts, so provider or filesystem access controls remain mandatory.

Version 1 is post-run only. In-progress records link to native CI, and Pipr does not add live tailing, a hosted collector, provider CLI dependencies, OTLP gRPC, or a second authorization service.
