---
name: pipr-prompt-regression
description: Diagnose and prevent Pipr review-quality regressions by turning a real bad or missing Review Finding, Inline Review Comment, Main Review Comment, or suggested fix into a minimal eval case, identifying the failing prompt, runtime, validation, or publication stage, applying the smallest correction, and proving before-and-after behavior. Use when Pipr emits noisy, redundant, contradictory, unsafe, unanchored, missing, or incorrectly suggested review output. Do not use for unrelated runtime bugs or generic test failures.
---

# Pipr Prompt Regression

Turn one concrete review-quality failure into a reproducible regression and a verified minimal correction. Keep prompt behavior, deterministic policy, and publication behavior separate so the fix lands at the owning layer.

## Preflight

1. Work from the Pipr repository root.
2. Read `AGENTS.md`, `docs/CONTEXT.md`, and `packages/evals/README.md`.
3. Record the raw failure artifact, expected behavior, relevant diff, model/provider, and whether the bad output reached the Main Review Comment or an Inline Review Comment. Redact secrets and private data.
4. If the user supplied a PR or comment link, read the full thread and candidate diff before changing files.

Do not tune a prompt from a paraphrase when the original output is available.

## 1. Locate The Failing Stage

Classify the first stage that violated its contract:

- **Review task or prompt**: the model received the wrong instruction or omitted a clear defect.
- **Eval case or scorer**: the expected behavior is missing, ambiguous, or scored incorrectly.
- **Schema or validation**: malformed, unsafe, unanchored, or over-budget output survived validation.
- **Suggested-fix policy**: the fix is identical, misaligned, too broad, uncertain, or changes the wrong range.
- **Publication or rendering**: valid output was deduplicated, routed, formatted, or published incorrectly.

Trace the artifact through `packages/evals/src`, `packages/runtime/src/review`, and `packages/runtime/src/hosts/github` as applicable. Fix the earliest owning stage. Do not compensate for a deterministic publication invariant by adding prompt prose.

## 2. Reproduce Before Editing

Add the smallest case that captures the failure in `packages/evals/src/cases.ts` or the nearest runtime test.

Choose the proof lane deliberately:

- Use a **deterministic case** for prompt-contract text, schema validation, anchoring, budgets, deduplication, rendering, and publication policy that fake Pi can reproduce.
- Use a **live case** for semantic recall, false-positive suppression, body quality, or suggested-fix judgment that depends on model behavior.
- Use both only when the regression crosses both contracts.

Keep subjective or unstable live cases in the broad advisory suite. Add a live case to a hard gate in `packages/evals/src/live-prompt-gates.ts` only when the expected behavior is unambiguous and repeated runs are stable.

Run the narrowest command that demonstrates the failure:

```bash
bun run --cwd packages/evals test
bun run --cwd packages/evals eval:deterministic
bun run --cwd packages/evals eval:suggested-fix
bun run eval:prompts
```

Live commands require `DEEPSEEK_API_KEY`. Follow `packages/evals/README.md`; never print, copy, or commit the key or Evalite output.

## 3. Apply The Smallest Correction

Prefer, in order:

1. a deterministic validation or publication rule for a deterministic invariant;
2. a scorer correction when the implementation is right but the proof is wrong;
3. a focused prompt correction for genuinely model-owned behavior.

Do not broadly rewrite review prompts, weaken unrelated gates, add loose keyword expectations, or turn an advisory judgment into a hard gate to make one example pass.

## 4. Verify Before And After

Run verification in this order:

1. the new focused test or eval and show that it failed before the correction;
2. the same focused proof after the correction;
3. `bun run --cwd packages/evals eval:deterministic`;
4. the relevant live hard gate when model behavior changed;
5. `bun run --cwd packages/evals eval:full:export` only when a broad advisory comparison is useful;
6. the repository-required final check before opening or updating a PR.

Compare the original and corrected outputs directly. Confirm finding presence or suppression, location, body alignment, suggested-fix shape, comment destination, and deduplication as applicable.

## Final Report

Report:

- the captured regression and owning stage;
- the new case and why its proof lane is deterministic, live, or both;
- the minimal correction;
- before-and-after evidence;
- exact commands and results;
- remaining model variance or advisory risk.
