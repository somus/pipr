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
| `bun run --cwd packages/evals eval` (root alias: `bun run eval:prompts`) | Focused live gates for recall, suppression, safety, and suggested fixes. | Yes |
| `bun run --cwd packages/evals eval:suggested-fix` | Targeted live gate for suggested-fix behavior. | Yes |
| `bun run --cwd packages/evals eval:dev` | Evalite watch mode for the focused live gates. | Yes |
| `bun run --cwd packages/evals eval:full` | Broad live suite for trend checks and investigation. | Advisory |
| `bun run --cwd packages/evals eval:full:export` | Broad live suite with JSON results in `evalite-export/results.json`. | Advisory |
| `bun run --cwd packages/evals benchmark:effectiveness` | Paired, repeated live benchmark with issue-level recall, precision, clean accuracy, and funnel counts. | Advisory |

Keep `DEEPSEEK_API_KEY` in the untracked `.pipr/.env`, but explicitly export only
that variable in a trusted shell before running live evals. The committed scripts
do not auto-load `.pipr/.env` because live eval code executes from the checked-out
branch. Do not commit provider keys or Evalite output.

The effectiveness benchmark compares the generic reviewer with a
failure-mode-focused variant over paired positive and clean fixtures covering
lifecycle regressions and an independent value-contract regression. It defaults
to three balanced repetitions. Use `--repetitions 1` for a smoke run,
`--cases <comma-separated ids>` to narrow the advisory run, or `--output <path>`
to select the report path.

Every run writes a JSON report under
`evalite-export/effectiveness/<timestamp>.json` unless `--output` is supplied.
The ignored report records the source revision and dirty-worktree flag, model,
prompt hashes, fixture snapshot hashes, issue IDs, sanitized findings, and aggregate scores. It keeps
structured model output, validation, and publication-eligible finding counts
separate so a recall miss cannot be mistaken for a validation or publication
drop. "Structured" starts after model output parsing and repair; the benchmark
does not claim access to raw provider text.

## Suite layout

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
| `src/effectiveness-cases.ts` | Paired positive and clean benchmark fixtures plus prompt variants. |
| `src/effectiveness.ts` | Repeated-run orchestration, issue matching, funnel metrics, metadata, and report writing. |
| `src/effectiveness-benchmark.ts` | Advisory live benchmark CLI. |

## Gate design

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

## Suggested fix policy

Suggested fixes are optional. They are only useful when the replacement is
small, exact, and directly fixes the defect named by the comment body.

The prompt asks the model to omit suggestions that are identical to the changed
lines, only add or remove trailing blank lines, require broad/generated/uncertain
changes, or invent secret, environment, or config wiring. Runtime publication
policy still validates emitted suggestions before code host publication.

Expected suggested-fix behavior uses two modes:

- `absent`: a recalled finding must not include a suggested fix.
- `if-present-exact`: no suggested fix is acceptable, but an emitted suggestion
  must exactly match the expected replacement after newline normalization.

`if-present-exact` lets a valid finding pass when the model omits an optional
fix. The recall scorer owns missing findings.

## Scoring rules

Scorers are intentionally narrow so one mistake does not hide another.

- Expected finding recall matches both location and body keywords.
- Effectiveness cases assign stable issue IDs and may provide several accepted
  keyword sets; one complete set must match, which tolerates valid paraphrases
  without accepting unrelated wording.
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

## Runtime testing export

Evals import review validation helpers from
`@usepipr/runtime/internal/review-testing`. That export is intentionally narrow:
it exposes the review policy constants and suggested-fix publication checks that
eval scoring needs.

Do not import broad runtime internals into Evalite. The narrow export keeps the
live eval process away from package entrypoints that are unrelated to review
testing and avoids bundling issues in the Evalite runner.
