# Pi Workspace-Copy Performance Debt

Status: Mitigated
Researched: 2026-07-14

## Verdict

The concern was real but bounded. Pipr copied the filtered workspace before every Pi process attempt, so provider fallback, transient retry, and invalid-output repair multiplied filesystem work. This was latency and filesystem-I/O debt rather than an architectural defect.

The root-owned Docker Action now creates and seals one filtered workspace snapshot per logical `ctx.pi.run` call. All process attempts in that call reuse the immutable snapshot while receiving fresh home, session, temp, prompt, and tool-bridge state. Independent or concurrent calls receive distinct snapshots, and non-root execution keeps the original per-attempt copy behavior because it cannot enforce the same ownership boundary.

## Evidence

Pipr excludes top-level `.git`, `node_modules`, `dist`, `.turbo`, `.fallow`, and `coverage` entries and drops symlinks when copying the workspace. With `p` selected providers, `t` transient retries, and `r` invalid-output repairs, the configured worst case remains `p * (t + 1) * (r + 1)` Pi processes, but the Action now pays one workspace-copy cost instead of one cost per process.

A warm-cache benchmark of the current macOS worktree used the exported `createReadOnlyWorkspace` path, which performs the same filtered copy and recursive read-only chmod. The copied tree contained 433 files, 96 directories, and 4,301,782 bytes. Five measured runs after two warmups took 135 to 149 ms, with a 142 ms mean. Docker overlay filesystems, network-backed workspaces, larger repositories, and cold caches may be materially slower, so this is local evidence rather than a general performance guarantee.

The Action E2E fixture forces two failed primary-provider attempts, one invalid fallback response, and one successful fallback repair. It verifies that all four attempts share one workspace, each attempt has isolated writable state, the snapshot is removed afterward, and concurrent `ctx.pi.run` calls do not share snapshots. The runtime unit suite separately verifies that non-root execution still creates a fresh workspace per attempt.

Relevant implementation: [Pi workspace scope](../../packages/runtime/src/pi/runner.ts) and [provider and retry scope](../../packages/runtime/src/review/agent/review-run.ts).
