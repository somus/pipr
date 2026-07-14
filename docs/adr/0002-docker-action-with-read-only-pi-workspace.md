# Docker Action with read-only Pi workspace

Status: Accepted

Pipr ships first as a Docker Action so the runtime can control Bun, Pi, git, ripgrep, fd, and local action testing consistently. Pi reviews run against a read-only workspace copy because pull request code, comments, and model output are untrusted, and Core MVP must not allow the review agent to modify files or run arbitrary project code.

The Docker Action also treats PR-authored `.pipr/` changes as untrusted for review settings. Provider backend, model, API-key env, provider options, and task topology come from base-commit `.pipr/config.ts` and its local imports. Pipr-owned review code owns deterministic diff creation, Pi execution, review validation, and comment publication. `config-dir` must resolve inside the repository root.

Pipr starts Pi with only read-only built-in tools inside the read-only workspace copy: `read`, `grep`, `find`, and `ls`. In the official Docker Action, the root Pipr supervisor owns and seals that copy, then starts Pi as UID and GID `1000`. Unix permissions prevent the Pi process from restoring write access to the copy.

Local runs and the non-root webhook container run Pipr and Pi under the same identity. Their mode bits and read-only tool allowlist remain defense in depth rather than a separate process-level filesystem boundary.

For condensed Diff Manifest runs, Pipr passes an explicit trusted Pi extension while keeping project extension discovery disabled. That extension can expose only bounded read helpers over Pipr-owned diff data and base/head file snapshots; it cannot provide shell, write, GitHub API, or publishing access.
