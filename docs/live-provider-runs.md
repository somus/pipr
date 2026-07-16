# Live provider run record

This record ties the documentation screenshots to public, disposable change requests. The runs used Pipr `0.4.0` source on 2026-07-14. Secrets stayed in provider or local secret stores and are not recorded here.

## Provider adapter runs

| Provider | Repository and change request | Model | Verified behavior | Assets |
| --- | --- | --- | --- | --- |
| GitHub | [`somus/event-relay` PR 1](https://github.com/somus/event-relay/pull/1) | DeepSeek V4 Pro, high thinking | Action delivery, exact-head checkout, main-comment upsert, inline anchoring, native suggestion, check publication, rerun deduplication | `github-review.png`, `github-inline.png` |
| GitLab.com | [`somasundaram321/event-relay` MR 1](https://gitlab.com/somasundaram321/event-relay/-/merge_requests/1) | DeepSeek V4 Pro, high thinking | CI delivery, webhook commands, exact-head checkout, main-comment upsert, inline anchoring, native suggestion, commit status, rerun deduplication | `gitlab-review.png`, `gitlab-inline.png` |
| Azure DevOps Services | [`pipr-adapter-live/event-relay` PR 2](https://dev.azure.com/pipr-adapter-live-20260714-321/pipr-adapter-live/_git/event-relay/pullrequest/2) | DeepSeek V4 Pro, high thinking | Service-hook delivery, exact-head checkout across repeated updates, main-thread upsert, iteration-aware inline anchoring, fenced-code fallback, native status publication, rerun deduplication | `azure-devops-review.png`, `azure-devops-inline.png` |
| Bitbucket Cloud | [`oksomu/event-relay` PR 1](https://bitbucket.org/oksomu/event-relay/pull-requests/1) | DeepSeek V4 Pro, high thinking | Repository-webhook delivery, exact-head checkout, main-comment upsert, multiline inline anchoring, Markdown-only hidden metadata, fenced-code fallback, source-commit status publication, rerun deduplication | `bitbucket-review.png`, `bitbucket-inline.png` |

Provider assets live in `apps/docs/public/images/pipr/providers/`.

## GitHub recipe runs

| Recipe | Change request | Model configuration | Verified behavior | Asset |
| --- | --- | --- | --- | --- |
| Default Review | [PR 1](https://github.com/somus/event-relay/pull/1) | DeepSeek V4 Pro, high | Automatic review summary and inline finding | `default-review.png` |
| Bug Hunter | [PR 2](https://github.com/somus/event-relay/pull/2) | DeepSeek V4 Pro, high with medium-thinking fallback | Focused correctness review with an actionable retry finding | `bug-hunter.png` |
| Structured Review | [PR 3](https://github.com/somus/event-relay/pull/3) | DeepSeek V4 Pro, high | Categorized structured review output | `rich-review.png` |
| Fix Suggestions | [PR 4](https://github.com/somus/event-relay/pull/4) | DeepSeek V4 Pro, high | Native suggested change and verifier result | `fix-suggestions.png` |
| Quality Gate | [PR 5](https://github.com/somus/event-relay/pull/5) | DeepSeek V4 Pro, high | Required provider check and review result | `quality-gate.png` |
| Diff Diagnostics | [PR 6](https://github.com/somus/event-relay/pull/6) | DeepSeek V4 Pro, high | Diff-scoped diagnostics and annotations | `diff-diagnostics.png` |
| Multi-agent Review | [PR 7](https://github.com/somus/event-relay/pull/7) | DeepSeek V4 Pro, high and medium | Parallel correctness, security, tests, and maintainability synthesis | `multi-agent-review.png` |
| Plugin Tool Review | [PR 8](https://github.com/somus/event-relay/pull/8) | DeepSeek V4 Pro, high | Disposable R2-backed memory tool invocation during review | `plugin-tool-review.png` |
| PR Briefing | [PR 9](https://github.com/somus/event-relay/pull/9) | DeepSeek V4 Pro, medium | Reviewer briefing with scope, risk, and test guidance | `pr-briefing.png` |
| Interactive Ask | [PR 10](https://github.com/somus/event-relay/pull/10) | DeepSeek V4 Pro, high | Real `@pipr ask` comment and command reply | `interactive-ask.png` |
| Security SAST | [PR 11](https://github.com/somus/event-relay/pull/11) | DeepSeek V4 Pro, high | Webhook-signature finding and required security check | `security-sast.png` |
| Dependency Risk | [PR 12](https://github.com/somus/event-relay/pull/12) | DeepSeek V4 Pro, high | Package and lockfile risk summary | `dependency-risk.png` |
| PR Hygiene | [PR 13](https://github.com/somus/event-relay/pull/13) | DeepSeek V4 Pro, medium | User-facing change and release-hygiene assessment | `pr-hygiene.png` |
| Changelog Draft | [PR 14](https://github.com/somus/event-relay/pull/14) | DeepSeek V4 Pro, medium | Changelog draft from a user-facing behavior change | `changelog-draft.png` |
| CI Triage Command | [PR 15](https://github.com/somus/event-relay/pull/15) | DeepSeek V4 Pro, high | Real command invocation with a failing CI log and diagnosis reply | `ci-triage-command.png` |

Recipe assets live in `apps/docs/public/images/pipr/recipes/`.
