# @pipr/e2e

`@pipr/e2e` is Pipr's private harness for local Action checks, direct-container
checks, scripted model runs, and fixture scenarios.

This workspace package is for Pipr maintainers. It is not part of the public
SDK or CLI surface.

## Technical notes

- `check.ts` (`check:actions`) builds the local Action image, verifies the durable harness
  contract (pinned `@earendil-works/pi-durable`, `pi-ai`, and `chord` versions
  plus `pipr agent-worker --help`), runs fixture assertions, and runs every local
  `act` scenario.
- `container-check.ts` (`check:container`) runs direct-container equivalents
  against an existing Docker image. It leaves the harness contract to
  `check:actions`, which the Docker e2e pipeline runs next.
- `run.ts` runs one local `act` scenario.
- `action-fixture.ts` is the in-container GitHub fixture entrypoint. It
  loads `scripted-provider.ts` into the agent worker as the model provider, so
  fixtures answer from the rendered prompt and drive the Pipr read tools without
  a model API call.

Use `check:actions` after editing Action behavior, Docker packaging, workflow
fixtures, agent worker or harness wiring, or PR event handling. Use
`check:container` when you already have a Docker image and need the
direct-container CI equivalent.

## Environment

| Variable | Purpose |
| --- | --- |
| `PIPR_ACTION_IMAGE` | Docker image used by local Action and container checks |
| `PIPR_SKIP_ACTION_IMAGE_BUILD` | Reuse an existing image when set to `1` |
| `PIPR_ACT_RUNNER_IMAGE` | Runner image used by local `act` scenarios |
| `PIPR_ACT_MODEL_CALL_DIR` | Directory for scripted model call logs |

## Commands

```bash
bun run --cwd packages/e2e check
bun run --cwd packages/e2e check:actions
bun run --cwd packages/e2e check:container
```

Deterministic prompt eval smoke tests run through the scripted eval provider
without a model API call:

```bash
bun run --cwd packages/evals eval:deterministic
```

Run live prompt evals explicitly when model credentials are available. Export
`DEEPSEEK_API_KEY` from a trusted shell; the committed eval scripts do not load
`.pipr/.env` from the checked-out branch:

```bash
bun run eval:prompts
bun run --cwd packages/evals eval:full
bun run --cwd packages/evals eval:full:export
```

`eval:prompts` runs focused live gates for recall, suppression, safety, and
suggested-fix behavior. `eval:full` is the broader advisory suite, and
`eval:full:export` writes reviewable results to
`packages/evals/evalite-export/results.json`. Live evals call DeepSeek through
the local Pipr review path and are intentionally not part of `mise run check`.
For suite layout and scoring rationale, see
[`@pipr/evals`](../evals/README.md).

## Docs

- [Contributing](../../CONTRIBUTING.md)
- [GitHub Action](https://pipr.run/docs/guide/github-action)
