# @pipr/e2e

`@pipr/e2e` is Pipr's private harness for local Action checks, direct-container
checks, fake Pi runs, and fixture scenarios.

This workspace package is for Pipr maintainers. It is not part of the public
SDK or CLI surface.

## Technical Notes

- `pipr-e2e-check` builds the local Action image, verifies the Pi CLI contract,
  runs fixture assertions, and runs every local `act` scenario.
- `pipr-e2e-container-check` runs direct-container equivalents against an
  existing Docker image.
- `pipr-e2e-run` runs one local `act` scenario.
- `pipr-e2e-action-fixture` is the in-container GitHub fixture entrypoint.

Use `check:actions` after editing Action behavior, Docker packaging, workflow
fixtures, Pi CLI mapping, or PR event handling. Use `check:container` when you
already have a Docker image and need the direct-container CI equivalent.

## Environment

| Variable | Purpose |
| --- | --- |
| `PIPR_ACTION_IMAGE` | Docker image used by local Action and container checks |
| `PIPR_SKIP_ACTION_IMAGE_BUILD` | Reuse an existing image when set to `1` |
| `PIPR_ACT_RUNNER_IMAGE` | Runner image used by local `act` scenarios |
| `PIPR_ACT_PI_CALL_DIR` | Directory for fake Pi call logs |
| `PIPR_EVAL_PI_EXECUTABLE` | Optional fake Pi executable override for deterministic prompt eval smoke tests |

## Commands

```bash
bun run --cwd packages/e2e check
bun run --cwd packages/e2e check:actions
bun run --cwd packages/e2e check:container
```

`check` includes deterministic prompt eval smoke tests through the fake Pi
harness. To run only those smoke tests:

```bash
bun run --cwd packages/evals eval:deterministic
```

Run live prompt evals explicitly when model credentials are available:

```bash
DEEPSEEK_API_KEY=... bun run eval:prompts
DEEPSEEK_API_KEY=... bun run --cwd packages/evals eval:export
```

`eval:export` writes reviewable results to
`packages/evals/evalite-export/results.json`. Live evals call DeepSeek through
the local Pipr review path and are intentionally not part of `mise run check`.

## Docs

- [Development](https://pipr.run/docs/reference/development)
- [GitHub Action](https://pipr.run/docs/guide/github-action)
