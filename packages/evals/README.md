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
| `bun run --cwd packages/evals eval:deterministic` | Scripted-provider prompt-contract smoke tests. No model API call. | Yes |
| `bun run --cwd packages/evals eval` (root alias: `bun run eval:prompts`) | Focused live gates for recall, suppression, safety, and suggested fixes. | Yes |
| `bun run --cwd packages/evals eval:suggested-fix` | Targeted live gate for suggested-fix behavior. | Yes |
| `bun run --cwd packages/evals eval:dev` | Evalite watch mode for the focused live gates. | Yes |
| `bun run --cwd packages/evals eval:full` | Broad live suite for trend checks and investigation. | Advisory |
| `bun run --cwd packages/evals eval:full:export` | Broad live suite with JSON results in `evalite-export/results.json`. | Advisory |

Keep `DEEPSEEK_API_KEY` in the untracked `.pipr/.env`, but explicitly export only
that variable in a trusted shell before running live evals. The committed scripts
do not auto-load `.pipr/.env` because live eval code executes from the checked-out
branch. Do not commit provider keys or Evalite output.

## Suite layout

The eval package separates fixtures, live suite selection, and scoring.

| File | Responsibility |
| --- | --- |
| `src/cases.ts` | Shared eval cases and expected behavior. Cases without `modes` run in both deterministic and live modes. |
| `src/prompt-gates.eval.ts` | Focused live hard gates grouped by behavior. |
| `src/suggested-fix-prompt.eval.ts` | Targeted wrapper for the suggested-fix gate. |
| `src/prompt-evals.eval.ts` | Broad advisory live suite over all live cases. |
| `src/live-prompt-gates.ts` | Shared live case groups, per-gate scorer selections, and environment checks. |
| `src/runner.ts` | Builds eval inputs, runs Pipr, and returns normalized outputs for scoring. |
| `src/deterministic-smoke.ts` | Runs deterministic evals through the scripted provider without calling a model API. |
| `src/scoring.ts` | The scorer table and deterministic scoring functions used by live and deterministic evals. |
| `src/scripted-provider.ts` | Agent worker model provider for deterministic evals: checks the prompt contract and answers from the rendered Diff Manifest. |

## Exported datasets

`pipr runs export --dataset <dir>` turns Finding Outcomes from decrypted Run
Bundles into labeled cases: fixed and still-valid findings expect the finding at
its line range, and dismissed findings expect no inline findings. Set
`PIPR_EVAL_DATASET=<dir>` to add them to `eval:full`; `datasetEvalCases` in
`src/cases.ts` validates each file against the SDK dataset schema. Exported
cases contain file contents and finding bodies, so keep them out of the
repository.

## Improve reviews from outcomes

The user-facing version of this loop is
`apps/docs/content/docs/guide/improve-reviews.mdx`. For prompt work in this
repository:

1. **Find the weak spot.** `pipr runs stats --group-by agent|facet|model|config`
   needs no identity. High dismissal or low acceptance for one agent or field
   value marks a noisy reviewer; a high drop rate marks validation or cap
   problems (check the reason codes).
2. **Export.** `pipr runs export --dataset <dir> --identity <path> --repo .`
   from a full clone. `index.json` counts skipped findings.
3. **Baseline.** Run `PIPR_EVAL_DATASET=<dir> bun run --cwd packages/evals
   eval:full:export` on the current prompt and keep `evalite-export/results.json`
   outside the repository.
4. **Change and compare.** Make one prompt or recipe change and rerun. Dataset
   positives (`fixed`, `still-valid`) should keep passing; dataset negatives
   (`dismissed`) that failed should now pass. Quieter output that loses
   positives is a regression.
5. **Promote.** Follow the `pipr-prompt-regression` skill: reduce a stable,
   repeatedly failing case to a minimal, non-sensitive fixture in
   `src/cases.ts`, and add it to `livePromptGateCaseIds` only when the expected
   behavior is unambiguous and repeated live runs agree.
6. **Confirm.** After release, `pipr runs stats --group-by config` should show
   the new config hash with lower dismissal and an unchanged fix rate.

Treat exported labels with care:

- A dismissal can mean deferred work, not a wrong finding, and `fixed` is the
  verifier's judgement. Read a sample of threads before trusting a rate.
- Dismissed cases expect zero inline findings for the whole case, so a file
  that also had a fixed finding fails the negative case on the legitimate one.
- Positive cases score path and range only (`keywords: []`).
- Dropped findings appear in stats but are never exported.
- Exported cases are live-only and noisy; they belong in the advisory
  `eval:full` suite, never directly in the hard gates.

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
- False-positive suppression uses location-only matching when expected findings
  exist, so wording misses are not double-penalized.
- Expected suggested-fix behavior is neutral when the expected finding was not
  recalled. Finding recall owns that failure.
- Suggested-fix range shape applies to any emitted suggestion and uses the
  runtime publication policy.
- Forbidden output suppression fails when the runner finds fixture leak strings
  or prompt-injection lure text in the raw review output, before it redacts them.

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
