# @pipr/evals

`@pipr/evals` owns Pipr's prompt evals for model-facing review behavior. Read
this before changing review prompts, recipe prompts, live eval cases, or eval
scoring.

The default live suite is a hard gate over stable, unambiguous cases. The full
live suite is advisory so noisy cases can still show prompt drift without
blocking unrelated prompt work.

## Commands

Use the narrowest command that covers the change.

| Command | Use | Gate |
| --- | --- | --- |
| `bun run --cwd packages/evals eval:deterministic` | Fake Pi prompt-contract smoke tests. No model API call. | Yes |
| `bun run eval:prompts` or `bun run --cwd packages/evals eval` | Focused live gates for recall, suppression, safety, and suggested fixes. | Yes |
| `bun run --cwd packages/evals eval:suggested-fix` | Targeted live gate for suggested-fix behavior. | Yes |
| `bun run --cwd packages/evals eval:dev` | Evalite watch mode for the focused live gates. | Yes |
| `bun run --cwd packages/evals eval:full` | Broad live suite for trend checks and investigation. | Advisory |
| `bun run --cwd packages/evals eval:full:export` | Broad live suite with JSON results in `evalite-export/results.json`. | Advisory |

Live scripts load `../../.pipr/.env` from the package script, so a local
`.pipr/.env` with `DEEPSEEK_API_KEY` is enough. You can also export
`DEEPSEEK_API_KEY` in the shell. Do not commit provider keys or Evalite output.

## Suite Layout

The eval package separates fixtures, live suite selection, and scoring.

| File | Responsibility |
| --- | --- |
| `src/cases.ts` | Shared eval cases and expected behavior. Cases without `modes` run in both deterministic and live modes. |
| `src/prompt-gates.eval.ts` | Focused live hard gates grouped by behavior. |
| `src/suggested-fix-prompt.eval.ts` | Targeted wrapper for the suggested-fix gate. |
| `src/prompt-evals.eval.ts` | Broad advisory live suite over all live cases. |
| `src/live-prompt-gates.ts` | Shared live case groups, Evalite scorers, and environment checks. |
| `src/runner.ts` | Builds eval inputs, runs Pipr, and returns normalized outputs for scoring. |
| `src/deterministic-smoke.ts` | Runs fake Pi evals without calling a model API. |
| `src/scoring.ts` | Deterministic scoring functions used by live and fake Pi evals. |
| `src/fake-pi.ts` | Fake Pi output for deterministic prompt-contract smoke tests. |

## Gate Design

Keep hard gates small and stable. Add a case to `livePromptGateCaseIds` only
when the expected behavior is unambiguous and repeated live runs are stable.

Keep broad or subjective cases in `eval:full`. For example,
`missing-regression-test` stays advisory because the model can reasonably treat
the threshold change as intentional and return no finding. It is still useful as
a trend signal.

Use the focused gates for regressions that would affect published review
quality:

- `suggestedFix`: no no-op suggestions, exact optional replacements, and no
  invented secret or config wiring.
- `defectRecall`: clear correctness and security defects that should produce an
  inline finding.
- `cleanSuppression`: harmless or out-of-scope changes that should stay quiet.
- `safetyHygiene`: prompt-injection lures and forbidden output checks.

## Suggested Fix Policy

Suggested fixes are optional. They are only useful when the replacement is
small, exact, and directly fixes the defect named by the comment body.

The prompt asks the model to omit suggestions that are identical to the changed
lines, only add or remove trailing blank lines, require broad/generated/uncertain
changes, or invent secret, environment, or config wiring. Runtime publication
policy still validates emitted suggestions before GitHub publishing.

Expected suggested-fix behavior uses two modes:

- `absent`: a recalled finding must not include a suggested fix.
- `if-present-exact`: no suggested fix is acceptable, but an emitted suggestion
  must exactly match the expected replacement after newline normalization.

`if-present-exact` lets a valid finding pass when the model omits an optional
fix. The recall scorer owns missing findings.

## Scoring Rules

Scorers are intentionally narrow so one mistake does not hide another.

- Expected finding recall matches both location and body keywords.
- False-positive suppression uses location-only matching when expected findings
  exist, so wording misses are not double-penalized.
- Expected suggested-fix behavior is neutral when the expected finding was not
  recalled. Finding recall owns that failure.
- Suggested-fix range shape applies to any emitted suggestion and uses the
  runtime publication policy.
- Forbidden output suppression scans review output for fixture leak strings and
  prompt-injection lure text.

Keep expected body keywords minimal and tied to the defect. Prefer one or two
words that prove the model identified the risk over broad prose expectations.

## Runtime Testing Export

Evals import review validation helpers from
`@usepipr/runtime/internal/review-testing`. That export is intentionally narrow:
it exposes the review policy constants and suggested-fix publication checks that
eval scoring needs.

Do not import broad runtime internals into Evalite. The narrow export keeps the
live eval process away from package entrypoints that are unrelated to review
testing and avoids bundling issues in the Evalite runner.
