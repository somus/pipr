---
name: pipr-action-e2e
description: Validate Pipr's GitHub Action through the narrowest relevant fixture, local act, container, or live GitHub lane, then collect evidence for workflows, events, permissions, checks, comments, reruns, and release references. Use after changing the Docker Action, action metadata, workflow fixtures, Pi CLI mapping, pull request event handling, GitHub publication, comment deduplication, or release packaging, and when reproducing a live Action failure. Do not use for ordinary runtime unit tests, prompt-only review behavior, or read-only inspection of an existing workflow run or code path unless reproduction or validation is requested.
---

# Pipr Action E2E

Drive Pipr's existing Action harness instead of creating an ad hoc repository or second test system. Escalate from local fixtures to live GitHub only when the behavior cannot be proved locally.

## Preflight

1. Work from the Pipr repository root.
2. Read `AGENTS.md` and `packages/e2e/README.md`.
3. Record the changed paths, expected Action behavior, event, action image or ref, and terminal proof required.
4. Check the worktree before running Docker, `act`, or remote commands. Preserve unrelated work.

## 1. Select The Narrowest Lane

Use one lane first:

- **Fixture or package**: run `bun run --cwd packages/e2e test` for assertion, scenario cleanup, or fake-Pi behavior.
- **One local act scenario**: run `bun packages/e2e/run.ts <scenario>` using a name already defined in `packages/e2e/scenarios.ts`.
- **Full local Action**: run `mise run check-actions` after Action, Docker, workflow, Pi CLI, publication, or event changes.
- **Existing image or direct container**: run `bun run --cwd packages/e2e check:container`, setting `PIPR_ACTION_IMAGE` only when an image is already available.
- **Docker packaging**: run `bun run docker:e2e` when the image itself changed.
- **Live GitHub**: use only when the user explicitly requests live proof or the failure depends on GitHub permissions, hosted events, checks, comments, or release references.

Do not run every lane by default. After a focused lane passes, run the repository-required final checks for the changed scope.

## 2. Diagnose Failures At The Owning Boundary

Classify the first failing boundary:

- image build or Action metadata;
- Pi CLI contract or container entrypoint;
- fixture setup, event payload, or head checkout;
- `.pipr/config.ts` loading or provider environment;
- Review Task execution, schema validation, or dropped findings;
- GitHub permissions, checks, Main Review Comment, Inline Review Comment, or thread actions;
- marker deduplication or rerun behavior;
- release tag, action ref, or dogfood workflow metadata.

Fix the earliest owning boundary, add or update the nearest scenario or assertion, and rerun the failed lane before broader checks.

## 3. Live GitHub Lane

Treat live validation as an external-write workflow.

Before changing remote state:

1. confirm `gh auth status` and the exact account;
2. identify the target owner, repository, branch, Action ref, PR, secret names, and cleanup policy;
3. obtain explicit authorization before creating a repository, pushing a branch, opening or editing a PR, changing secrets or permissions, rerunning workflows, or deleting remote resources;
4. never expose secret values in commands, logs, comments, or the final report.

Prefer an existing authorized fixture repository. Create a temporary repository only when explicitly requested. Use structured `gh` output and record URLs and identifiers instead of scraping terminal prose.

Validate the requested behaviors:

- the expected event triggered the intended workflow;
- required workflow permissions and check runs behaved correctly;
- the Action used the intended release tag, branch, SHA, or container image;
- Main Review Comment and Inline Review Comment markers, locations, head SHA, and counts are correct;
- dropped findings and publication errors are visible where expected;
- rerunning the same candidate does not duplicate comments or thread actions;
- a new head SHA produces the expected update behavior.

Wait for required checks with bounded polling. Inspect failing job logs before editing code. Do not claim live success from a local `act` run.

## 4. Cleanup

Clean local scenario worktrees and toolcache through the existing harness. For remote state, follow the approved cleanup policy. Deleting repositories, branches, PRs, secrets, or releases requires explicit authorization even when the skill created them.

## Final Report

Report:

- the selected lane and why it was sufficient;
- image or Action ref, event, scenario, repository, and PR when applicable;
- exact commands and checks;
- expected versus observed comments, checks, permissions, and rerun behavior;
- fixes and added regression coverage;
- cleanup performed and remote state intentionally left behind;
- whether proof is local, container, or live GitHub.
