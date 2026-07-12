# Code Host Adapter Guideline for GitLab, Bitbucket Cloud, and Azure DevOps

Status: Research guideline
Researched: 2026-07-12
Target: Pipr runtime and CI integration planning

## Recommendation

Implement the three providers on top of one strengthened `CodeHostAdapter` contract, then build thin provider modules for native event parsing, repository coordinates, API access, checkout, publication, inline location mapping, permissions, and status reporting. Do not implement three copies of the review runtime. Diff construction, Pi execution, Review Finding validation, marker generation, stale-head policy, deduplication, and publication planning should remain in Pipr Core.

The APIs can support the core review path on all three providers. GitLab has the closest match to GitHub's discussion model, Azure DevOps has the most explicit diff-iteration model, and Bitbucket Cloud has the sparsest inline-comment API documentation. Full feature parity also needs a trusted event runner: native merge or pull request pipelines can run reviews, but comment commands and verifier replies require webhook events, and source-controlled CI configuration cannot safely be trusted with write credentials for arbitrary untrusted changes.

## Scope

This guideline targets:

- GitLab.com REST API v4. GitLab Dedicated and Self-Managed are future compatibility work.
- Bitbucket Cloud REST API 2.0. Bitbucket Data Center is a separate adapter because its REST paths, authentication, permission model, webhook payloads, and inline comment payloads are different.
- Azure DevOps Services REST API 7.1. Azure DevOps Server can be considered later behind the same adapter only after compatibility tests against the minimum supported server version.

The target behavior is the current Pipr product contract:

- normalize a native merge or pull request into a Change Request;
- load Trusted Base Config from the target-side commit;
- check out and review the exact source head;
- build the existing Diff Manifest locally;
- publish or update one Main Review Comment;
- publish deduplicated Inline Review Comments on validated Diff Manifest ranges;
- load prior Pipr state and open inline threads;
- reply to and resolve prior threads when the verifier explicitly marks findings fixed;
- publish task and aggregate status equivalents;
- support dry-run fixtures and provider-specific end-to-end tests;
- support `@pipr` command comments where the provider supplies a trustworthy comment event and effective actor authorization can be established.

This is not a guideline for mirroring provider diffs into Pipr. The local Git checkout remains the source for the Diff Manifest. Provider diff APIs are needed only for native inline-location metadata that cannot be reconstructed reliably from the local unified diff.

## Feasibility summary

| Capability | GitLab | Bitbucket Cloud | Azure DevOps |
| --- | --- | --- | --- |
| Load change request and current head | Direct | Direct | Direct |
| Main Review Comment create/update | Direct note API | Direct comment API | Direct root thread and comment APIs |
| Added-line inline comment | Direct diff discussion | Direct inline comment | Direct right-side thread |
| Deleted-line inline comment | Direct diff discussion | Direct inline comment | Direct left-side thread |
| Multi-line inline comment | Direct, but requires line codes | Payload exposes range fields; contract test required | Direct start/end positions |
| Replies and thread resolution | Direct discussion APIs | Direct parent comment and resolve APIs | Direct thread comment and status APIs |
| Status/check equivalent | Commit pipeline status | Commit build status | Pull request status |
| Native review trigger | Merge request pipeline or webhook | Pull request pipeline or webhook | Branch-policy validation or service hook |
| Native comment trigger usable by Pipr | Webhook only | Webhook only | Service hook only |
| Effective command actor permission | Project member API | Effective permission API requires workspace admin | Requires security namespace and group evaluation |
| Suggested fix UI | Documented suggestion Markdown | UI supports suggestions, REST encoding is not documented | UI supports suggestions, REST encoding is not documented |

The first production milestone should cover automatic review, Main Review Comment, Inline Review Comments, prior-state loading, status reporting, and stale-head protection. Commands and reply-driven verification should be a second milestone unless a trusted webhook ingress is part of the same project.

## Live validation status

Live browser tests ran on 2026-07-12 against private disposable fixtures on GitLab.com, Bitbucket Cloud, and Azure DevOps Services. The tests used each provider's authenticated UI and, where needed, the documented public REST contract through the same signed-in browser session. No credentials, session material, account identifiers, or private fixture URLs were recorded.

### GitLab.com result

A private project, feature branch, merge request, two-line inline thread, and one-click suggestion were created successfully. The UI submitted the inline thread with a position containing the latest `base_sha`, `start_sha`, and `head_sha`, both paths, `position_type: text`, `new_line`, and a `line_range` whose start and end each carried `line_code`, side type, old line, and new line. The UI returned HTTP 200 and rendered the thread on lines `+3` through `+4`.

The UI-generated suggestion body used this Markdown form:

~~~text
```suggestion:-0+0
replacement line
```
~~~

This validates GitLab's line-code and range model plus directly applicable suggestion rendering. The adapter should still publish through the documented REST v4 discussions endpoint, not GitLab's private browser endpoint, and should obtain all three SHAs from the latest merge request version immediately before publication.

### Bitbucket Cloud result

A private repository, feature branch, pull request, and added-line inline comment were created successfully. The browser submitted HTTP 201 to Bitbucket's authenticated UI proxy with this logical body:

```json
{
  "content": { "raw": "Pipr live compatibility check." },
  "inline": { "path": "GUIDELINE.md", "to": 4 },
  "anchor": "<source-head-prefix>",
  "dest_rev": "<destination-head-prefix>"
}
```

The public adapter should continue using the documented `api.bitbucket.org/2.0` endpoint and public schema. The private UI proxy's `anchor` and `dest_rev` fields are evidence that Bitbucket's own client binds the comment to both revisions, but they are not a supported public API contract.

The web editor represented a simultaneous filename change and content replacement as one added file and one removed file, so that fixture did not prove native rename anchoring. A single added-line anchor on the destination path is proven. The current UI path did not produce a multi-line selection or a submitted code suggestion, so added and deleted range combinations plus suggestion encoding remain mandatory authenticated REST tests before those capabilities are enabled.

### Azure DevOps Services result

A private organization, project, repository, source branch, and pull request were created successfully. The public REST 7.1 thread endpoint rejected `firstComparingIteration: 0` with HTTP 400 even though the Files UI uses `baseIterationId: 0` when it asks its internal data provider for the merge-base diff. The same initial thread succeeded with HTTP 200 when both iteration fields were `1`; after a source push created iteration `2`, a thread using `{ firstComparingIteration: 1, secondComparingIteration: 2 }` also succeeded and rendered in the Files UI.

The initial thread covered right-side lines 3 through 5 and used `changeTrackingId: 1`. Its end was the Unicode line `café naïve 🙂` at offset 14. The UI's diff spans exposed zero-based JavaScript string offsets 0, 5, and 11 for the three text segments, while the public thread request accepted the corresponding one-based UTF-16 end offset. This proves a multiline added-side range containing a supplementary-plane character. The adapter should count offsets as UTF-16 code units and add one at the API boundary.

A later edit retained `changeTrackingId: 1`. A pure repository rename then appeared in PR iteration changes as a delete of the original path with tracking ID 1 and an add of the destination path with tracking ID 2, rather than one rename entry. A left-side thread on the deleted path and a right-side thread on the destination path both returned HTTP 200 and rendered in the UI with `{ firstComparingIteration: 1, secondComparingIteration: 3 }`. The adapter must index both current and original paths and handle this split representation. Retarget behavior was not exercised and remains a required contract test. Suggested-change encoding remains disabled because the public thread API still has no documented or stable live payload for it.

### Fixture lifecycle

Cleanup completed after validation. GitLab moved its private project into the provider's pending-deletion state, Bitbucket removed the private repository and its now-empty fixture project, and Azure DevOps removed the disposable organization and all contained resources. The Azure organization URL returned 404 after deletion. Provider recovery windows may retain soft-deleted data temporarily. No provider account identifiers, private repository URLs, credentials, or captured analytics data are committed here.

## Current Pipr boundary

Pipr already has the right high-level ownership rule in [ADR 0001](../adr/0001-pipr-owns-pr-runtime-pi-owns-agent-execution.md) and [ADR 0005](../adr/0005-pipr-owned-comment-publishing.md): Pipr Core owns deterministic review behavior, while a Code Host Adapter owns native events, permissions, checkout, publication, and inline mapping.

The implementation is partially ready:

- `packages/runtime/src/hosts/types.ts` defines `CodeHostAdapter`, `CodeHostEvents`, `CodeHostWorkspace`, `CodeHostPermissions`, `CodeHostPublication`, `CodeHostComments`, and `CodeHostStatuses`.
- `packages/runtime/src/hosts/github/adapter.ts` is a useful composition reference.
- `packages/runtime/src/review/*` is mostly provider-neutral and should remain shared.
- `packages/runtime/src/hosts/github/*` cleanly contains most GitHub REST and GraphQL behavior.

Several seams still encode GitHub assumptions and should be fixed once before implementing provider modules:

- `packages/runtime/src/action/commands.ts` selects the event path using `GITHUB_EVENT_NAME` and documents the command as a GitHub Action workflow.
- `packages/runtime/src/action/action-host.ts` defaults directly to the GitHub adapter and exposes GitHub-specific client injection.
- `packages/runtime/src/action/types.ts` exposes GitHub-specific test dependencies.
- `packages/runtime/src/action/runtime-checks.ts`, `packages/cli/src/runner.ts`, and several logs and errors call the generic status capability a GitHub Check Run.
- `packages/runtime/src/action/verifier-entry.ts` contains the literal `github-actions[bot]` actor rule.
- `packages/runtime/src/review/agent/agent-prompt.ts` tells the model that GitHub applies `suggestedFix`.
- `packages/runtime/src/config/init.ts` supports only the GitHub workflow and `pipr init` rejects the three target adapters.
- `RepositoryRef` carries only `slug` and `url`. That is insufficient as a durable API locator for Azure's organization, project, and repository UUID, and it encourages fragile parsing for the other providers.
- `HostEventParseOptions.eventPath` is mandatory even though GitLab, Bitbucket, and Azure pipeline jobs primarily provide environment variables rather than an event JSON file.

## Strengthen the shared contract first

### 1. Select the provider explicitly

Add a provider resolver at the CLI boundary. The recommended order is:

1. explicit `--host` or `PIPR_CODE_HOST`;
2. a single recognized CI environment (`GITHUB_ACTIONS`, `GITLAB_CI`, `BITBUCKET_BUILD_NUMBER`, or `TF_BUILD`);
3. fail on zero or multiple matches.

Do not silently default to GitHub once more than one production adapter exists. A wrong adapter can read valid-looking environment variables and publish to the wrong native resource.

Rename the internal Action command to a provider-neutral host-run concept while retaining `pipr action` as a public command only if compatibility requires it. Logs, dry-run help, errors, and outputs should use Code Host Adapter or host run terminology.

### 2. Separate event kind from provider action

The current dispatcher infers three paths from GitHub event names. Introduce a normalized event envelope:

```ts
type CodeHostEvent =
  | { kind: "change-request"; action?: string; rawAction?: string; change: ChangeRequestEventContext }
  | { kind: "command-comment"; action?: string; rawAction?: string; comment: CommandCommentEvent }
  | { kind: "review-comment-reply"; action?: string; rawAction?: string; reply: ReviewCommentReplyEvent };
```

Make the adapter return this envelope from one `parseEvent` call. Pipeline-backed review runs may synthesize a `change-request` event from CI variables plus a provider API read. Webhook-backed runs should parse and validate the native payload. `eventPath` should therefore be optional, while `env` and `workspace` remain required.

Keep the existing provider-neutral actions such as `opened`, `updated`, `ready`, `reopened`, and `closed`. Store the provider's original value in `rawAction`. A pipeline that cannot distinguish create from update must not guess. It should receive an explicit `PIPR_CHANGE_ACTION` from the launcher or normalize to `updated` and document the reduced trigger semantics.

### 3. Add structured native coordinates

Keep `RepositoryRef.slug` as a display value, but add a validated provider locator that adapters can use without reparsing URLs:

```ts
type CodeHostCoordinates =
  | { provider: "github"; owner: string; repository: string }
  | { provider: "gitlab"; projectId: string; projectPath: string }
  | { provider: "bitbucket"; workspace: string; repository: string; repositoryUuid?: string }
  | {
      provider: "azure-devops";
      organization: string;
      project: string;
      projectId?: string;
      repositoryId: string;
    };
```

Either place this on `ChangeRequestEventContext` or let `CodeHostAdapter` close over it when the event is parsed. Do not put unvalidated `unknown` provider data in the public Pipr SDK. The union is an internal trust-boundary type and should be parsed with zod.

### 4. Make native identifiers opaque

Provider thread IDs are not uniformly numeric. GitLab discussion IDs are strings, Azure thread IDs are integers, and comment identifiers can require a compound thread/comment address. Replace numeric-only publication identifiers with opaque internal types:

```ts
type NativeId = string;

type NativeCommentAddress = {
  threadId?: NativeId;
  commentId: NativeId;
};
```

Keep these values internal. User-facing Review Finding IDs and Pipr markers remain stable provider-neutral strings.

### 5. Make capabilities explicit

Optional methods currently imply capabilities, but they do not explain why a feature is unavailable. Add a capability descriptor returned by the adapter:

```ts
type CodeHostCapabilities = {
  commandComments: boolean;
  reviewCommentReplies: boolean;
  threadResolution: boolean;
  multilineInlineComments: boolean;
  suggestedChanges: boolean;
  statuses: boolean;
};
```

Use it for plan inspection, init output, docs, and early validation. A provider may support a capability only under a stronger credential scope. In that case the adapter should expose configuration-aware capability checks rather than fail after Pi has run.

### 6. Preserve the trusted base and exact head invariant

Every provider flow must establish these values before loading config or running Pi:

- target repository;
- change request number or IID;
- target/base commit SHA used for Trusted Base Config;
- exact source head SHA being reviewed;
- source and target repository and ref names;
- whether the source is a fork;
- current native diff or iteration identity when inline publication needs it.

The adapter must make the base and head commits available locally, load `.pipr/config.ts` from the base SHA, then detach checkout to the exact head SHA. Immediately before the first write, it must read the current native head again and compare it with `reviewedHeadSha`. This is the same non-atomic but retry-safe policy documented in ADR 0005.

### 7. Share transport behavior, not provider schemas

Use a small internal HTTP client for:

- base URL and authentication headers;
- JSON and text responses;
- zod parsing at each API boundary;
- redacted errors;
- pagination callbacks;
- `Retry-After` handling and bounded retry for 429 and transient 5xx responses;
- request IDs in diagnostic metadata.

Treat `Retry-After` as provider-specific control flow. In particular, Azure can delay a request, return a successful `200`, and include `Retry-After` for subsequent calls. Do not repeat a successful write; delay only the next request. Azure documents this behavior in [rate and usage limits](https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits?view=azure-devops).

Keep endpoint paths, pagination shapes, and response schemas in each provider folder. GitLab uses page headers and `page`/`per_page`, Bitbucket requires following opaque `next` URLs, and Azure endpoints mix arrays, `$top`/`$skip`, and continuation headers. A universal paginator would hide meaningful differences and make failures harder to diagnose.

## Target adapter module layout

Use the GitHub folder as a pattern, with each provider owning the same responsibilities:

```text
packages/runtime/src/hosts/
  gitlab/
    adapter.ts
    api-client.ts
    event.ts
    inline.ts
    publication.ts
    permissions.ts
    status.ts
    workspace.ts
    tests/
  bitbucket/
    ...
  azure-devops/
    ...
```

Do not create one generic provider client with large switches. Shared mechanics belong in `hosts/shared`; provider terminology, schemas, and endpoint contracts stay in the provider folder.

## Adapter method mapping

| Pipr operation | GitLab | Bitbucket Cloud | Azure DevOps |
| --- | --- | --- | --- |
| Load change | `GET /projects/:id/merge_requests/:iid` | `GET /repositories/{workspace}/{repo}/pullrequests/{id}` | `GET .../repositories/{repoId}/pullrequests/{id}` |
| Read current head | MR `sha` or `diff_refs.head_sha` | PR `source.commit.hash` | PR `lastMergeSourceCommit.commitId` |
| Read native diff version | MR versions or `diff_refs` | PR source and destination commits | PR iterations and iteration changes |
| List main and inline comments | MR notes plus discussions | PR comments, which include global, inline, and replies | PR threads and their comments |
| Create main comment | Create MR note | Create PR global comment | Create PR thread without `threadContext` |
| Update main comment | Update MR note | Update PR comment | Update the root thread's first comment |
| Create inline | Create positioned discussion | Create comment with `inline` | Create thread with `threadContext` and PR iteration context |
| Reply inline | Add discussion note | Create comment with parent | Create comment in thread with `parentCommentId` |
| Resolve inline | Resolve discussion | Resolve comment thread | Update thread status to `fixed` |
| Status | Commit pipeline status | Commit build status | Pull request status, preferably on iteration |
| Effective actor permission | Project member lookup | Workspace effective repository permissions | Security namespace and identity evaluation |

## GitLab adapter

### Native identity and event normalization

Use the target project ID as the API key and the project path as the display slug. GitLab merge request numbers are project-scoped IIDs, which map directly to `change.number`.

For a GitLab CI merge request pipeline, read `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_PROJECT_ID`, `CI_MERGE_REQUEST_PROJECT_PATH`, `CI_MERGE_REQUEST_SOURCE_PROJECT_ID`, source and target branch names, `CI_COMMIT_SHA`, `CI_PROJECT_URL`, and `CI_SERVER_URL`. Do not rely on `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` or `CI_MERGE_REQUEST_TARGET_BRANCH_SHA` in a normal merge request pipeline because GitLab documents that both are empty there; fetch the merge request API object and its diff refs instead. GitLab's [predefined variable reference](https://docs.gitlab.com/ci/variables/predefined_variables/) documents these values.

For webhooks, validate the secret or signature before parsing. Merge request hooks cover creation, edits, merges, closes, and source-branch commits. Note hooks cover new or edited comments. GitLab includes a retry-stable idempotency key in webhook headers and explicitly warns receivers to handle duplicate deliveries. Current GitLab 19.x can sign deliveries with HMAC and a timestamp, while older self-managed versions use the plain `X-Gitlab-Token`; minimum-version support must therefore select the verification scheme explicitly. See [webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/) and [webhook delivery requirements](https://docs.gitlab.com/user/project/integrations/webhooks/).

Recommended action mapping:

| GitLab source | Native action | Pipr action |
| --- | --- | --- |
| Merge request hook | `open` | `opened` |
| Merge request hook | `update` with changed source SHA or `oldrev` | `updated` |
| Merge request hook | `reopen` | `reopened` |
| Merge request hook | draft becomes ready | `ready` |
| Merge request hook | `close` | `closed` |
| CI merge request pipeline without launcher metadata | unavailable | `updated` |
| Note hook on MR overview | create/update | command-comment candidate |
| Note hook on DiffNote or DiscussionNote | create/update | review-comment-reply candidate |

### Authentication and permissions

Use a project access token with the `api` scope and a role sufficient to comment and resolve discussions. Project access tokens create a project bot user and are scoped to one project, but GitLab.com availability depends on the subscription. A group access token is the multi-project alternative. Personal access tokens should be limited to development. GitLab documents token forms and headers in [REST API authentication](https://docs.gitlab.com/api/rest/authentication/) and project bot behavior in [project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/).

Do not assume `CI_JOB_TOKEN` can publish reviews. GitLab job tokens are accepted only by a documented subset of endpoints, and the merge request note and discussion write paths are not a safe general contract for job-token publication.

For command authorization:

1. Resolve the webhook user ID from the note event or Users API.
2. Call `GET /projects/:id/members/all/:user_id` to include inherited and invited-group membership.
3. Map GitLab access levels to Pipr levels: Guest to `read`, Planner or Reporter to `triage`, Developer to `write`, Maintainer to `maintain`, Owner to `admin`, and missing membership to `none`.
4. Treat public non-members as `read` only if the project is public and the command policy intentionally permits read-level users.

The effective member endpoint and access levels are documented by the [Project members API](https://docs.gitlab.com/api/project_members/).

### Change and diff reads

Use `GET /projects/:id/merge_requests/:iid` for title, description, author, refs, fork/source project, URL, and current head. `diff_refs` provides base, head, and start SHAs but can be empty immediately after merge request creation because GitLab fills it asynchronously. Bound a retry before declaring the event incomplete.

Use `GET /projects/:id/merge_requests/:iid/versions` before inline publication. The latest version supplies `base_commit_sha`, `head_commit_sha`, and `start_commit_sha`, which GitLab requires for positioned discussions. `GET /projects/:id/merge_requests/:iid/diffs` is paginated, supports unified diff output, and flags collapsed or too-large files, but Pipr should continue constructing the Diff Manifest from local Git. See the [Merge requests API](https://docs.gitlab.com/api/merge_requests/).

### Main Review Comment and prior state

Use merge request notes for the Main Review Comment:

- list `GET /projects/:id/merge_requests/:iid/notes` with pagination;
- find the authenticated bot's note containing Pipr's main marker;
- update it with `PUT .../notes/:note_id`, or create it with `POST .../notes`;
- preserve the full marker and state body because GitLab notes are the durability store.

GitLab notes are not line-attached, are editable, and support bodies up to 1,000,000 characters. See the [Notes API](https://docs.gitlab.com/api/notes/).

List discussions separately for prior Inline Review Comments and verifier state. A discussion contains its notes, resolved state, and native position. Parse Pipr inline markers only from notes owned by the configured bot identity.

### Inline mapping

Create an inline thread with `POST /projects/:id/merge_requests/:iid/discussions`. GitLab requires `position_type=text`, both old and new paths, and the latest version's base, head, and start SHAs.

Map Pipr sides as follows:

- `RIGHT`: set `new_line`; do not set `old_line` for an added line.
- `LEFT`: set `old_line`; do not set `new_line` for a removed line.
- unchanged context: set both old and new line values only when the Diff Manifest can prove both coordinates.

For multi-line ranges, GitLab requires start and end line objects and a `line_code` of `<SHA1(path)>_<old>_<new>`. Generate the SHA-1 from the native file path and use zero for the absent side. Contract tests must cover added, deleted, renamed, and unchanged ranges. The complete position and line-code rules are in the [Discussions API](https://docs.gitlab.com/api/discussions/).

GitLab supports suggestion Markdown in diff threads, including multi-line suggestions of up to 200 lines. Move suggestion rendering behind the adapter and use GitLab's documented syntax rather than the current GitHub-specific renderer. See [Suggest changes](https://docs.gitlab.com/user/project/merge_requests/reviews/suggestions/).

Reply with `POST .../discussions/:discussion_id/notes` and resolve with `PUT .../discussions/:discussion_id?resolved=true`. GitLab requires the author, Developer, Maintainer, or Owner role to resolve a thread, so validate this during adapter initialization.

### Status equivalent

Map Pipr check conclusions to GitLab external commit pipeline statuses on the reviewed source SHA:

- starting: `running`;
- success: `success`;
- failure: `failed`;
- neutral or skipped: `skipped`.

Use a stable status name per task and include the source ref. GitLab may append the status to an existing pipeline or create an external pipeline, and can return 409 while another status update is in progress. Retry that conflict with a short bounded backoff. See [Commit status API](https://docs.gitlab.com/api/commits/#commit-status) and [external commit statuses](https://docs.gitlab.com/ci/ci_cd_for_external_repos/external_commit_statuses/).

### Checkout and CI

A minimum CI-only launcher uses a merge request pipeline rule, the Pipr image with an empty overridden entrypoint if required by the runner, and `GIT_DEPTH: "0"`. GitLab's default clone is shallow, and the target commit used for Trusted Base Config may otherwise be missing. See [merge request pipelines](https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/), [runner Git behavior](https://docs.gitlab.com/ci/runners/configure_runners/), and [Docker job images](https://docs.gitlab.com/ci/docker/using_docker_images/).

Do not call the CI-only launcher a secure fork solution. GitLab states that fork pipelines normally run in the fork, and a parent-project pipeline uses the fork's CI configuration with parent resources. Protected variables are available to merge request pipelines only under strict protected-branch conditions, and never to fork merge requests. The production design should launch a trusted runner from a validated webhook or a target-owned orchestration project rather than expose model and GitLab write tokens to source-authored CI.

## Bitbucket Cloud adapter

### Scope and native identity

Use the workspace slug and repository slug as API coordinates, retain the repository UUID when available, and map the repository-scoped pull request integer ID to `change.number`. Pull request payloads include source and destination branches, commits, and repositories, which is enough to detect forks and build the neutral endpoints. See [Bitbucket event payloads](https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/).

Bitbucket Data Center must not share this module. Its endpoints use project keys and repository slugs under `/rest/api/latest`, and its inline comment contract uses a different anchor model.

### Authentication and permissions

For a repository installation, prefer a repository access token so the bot identity and blast radius are repository-scoped. Use OAuth or a workspace access token only when one installation must span repositories. API tokens tied to a human are acceptable for development, not the recommended production identity. Bitbucket documents these choices, token identity behavior, and scopes in [REST API authentication](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).

The minimum functional scopes are:

- pull request read/comment scope for PR reads, comments, replies, and thread resolution;
- repository read scope for commit statuses and any repository endpoint used by the adapter;
- webhook scope only for installation management, not for handling an already configured webhook.

Atlassian's current granular scope names distinguish `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`, and `read:repository:bitbucket`; the legacy OAuth scope names are `pullrequest`, `pullrequest:write`, and `repository`. Use the scope vocabulary that matches the selected token mechanism and test every write during adapter setup.

Command authorization is the main least-privilege problem. `GET /workspaces/{workspace}/permissions/repositories` returns effective repository permissions, including indirect group privileges, but only workspace administrators can call it. A write-scoped review bot therefore cannot securely resolve arbitrary command actors by itself. Choose one of these explicit product decisions:

1. require an admin-capable credential for commands while keeping automatic reviews on a narrower credential;
2. accept an authorization assertion from a trusted installation service;
3. disable `@pipr` commands on Bitbucket Cloud initially.

Do not use the newer repository `permissions-config` endpoint as an effective permission check. It exposes explicit assignments and requires repository admin scope. The effective workspace endpoint is documented in the [Workspaces API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-workspaces/), and the explicit permission endpoints are described in Atlassian's [repository permission API announcement](https://developer.atlassian.com/cloud/bitbucket/new-repo-permission-apis/).

Map effective Bitbucket repository permissions as `read` to Pipr `read`, `write` to Pipr `write`, and `admin` to Pipr `admin`. Bitbucket has no direct equivalents for Pipr `triage` and `maintain` at repository scope.

### Events

Repository webhooks expose `pullrequest:created`, `pullrequest:updated`, and `pullrequest:comment_created`, plus resolution and reopening events. Validate `X-Hub-Signature` with the configured webhook secret and compare the HMAC in constant time. Dispatch on `X-Event-Key`, and retain `X-Hook-UUID`, `X-Request-UUID`, and `X-Attempt-Number` for diagnostics and delivery dedupe. Bitbucket retries a failed delivery twice, so handler idempotency is mandatory. Webhook registration documents the secret and signature behavior in the [Workspaces API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-workspaces/); headers and payload shapes are in [Event payloads](https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/) and [Manage webhooks](https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/).

Recommended mapping:

| Bitbucket event | Pipr event |
| --- | --- |
| `pullrequest:created` | change request `opened` |
| `pullrequest:updated` with changed source hash | change request `updated` |
| `pullrequest:comment_created` without parent or inline anchor | command-comment candidate |
| `pullrequest:comment_created` with parent or inline thread | review-comment-reply candidate |
| `pullrequest:fulfilled`, `rejected`, `superseded` | terminal events, normally ignored by review tasks |

Ignore bot-authored comment events before dispatch to prevent loops.

### Change, Main Review Comment, and prior state

Use the [Pullrequests API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/):

- load the PR with `GET /repositories/{workspace}/{repo}/pullrequests/{id}`;
- list all comments with `GET .../comments`, following the response's opaque `next` URL;
- create a global Main Review Comment with `POST .../comments` and `content.raw`;
- update it with `PUT .../comments/{comment_id}`;
- use the PR source commit hash for the stale-head check.

The diff, diffstat, and patch endpoints respond with redirects to repository-level resources. Follow redirects only when the target remains on the expected Bitbucket API origin, and do not forward an authorization header to an unvalidated origin.

The comment list contains global comments, inline comments, and replies in one paginated collection. Classify them by `inline`, parent, and resolution fields, and parse markers only from the bot's comments. Bitbucket pagination clients must follow `next` rather than construct page URLs; see [REST pagination](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#pagination).

### Inline mapping

Create Inline Review Comments with the same PR comment endpoint and an `inline` object:

- `path`: changed file path;
- `to`: new-file line for Pipr `RIGHT`;
- `from`: old-file line for Pipr `LEFT`;
- `start_to` or `start_from`: start of a multi-line range;
- `content.raw`: marker plus rendered finding body.

Only set fields for the selected side. Preserve rename-aware paths from the Diff Manifest and verify whether Bitbucket expects the destination path for both old and new anchors through live contract tests.

The REST reference exposes `from`, `to`, `start_from`, `start_to`, and `path` but does not explain all valid combinations or server behavior for mixed/context ranges. The canonical field schema is also available in Atlassian's [Bitbucket OpenAPI document](https://developer.atlassian.com/cloud/bitbucket/swagger.json). Treat added single-line, deleted single-line, added multi-line, deleted multi-line, rename, outdated comment, and invalid-line cases as a required live API spike before declaring parity.

Bitbucket's inline request contains no source commit or diff-version identifier. The stale-head read immediately before publication is therefore part of location correctness, not only retry policy. Abort the entire write sequence unless the latest `source.commit.hash` still equals `reviewedHeadSha`; otherwise a valid line number could be applied to a newer diff.

Reply using the comment parent relationship and resolve with `POST .../comments/{comment_id}/resolve`; reopen with the corresponding `DELETE`. Bitbucket documents that the comment list includes replies and exposes resolve/reopen endpoints in the [Pullrequests API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).

Bitbucket Cloud's UI supports code suggestions, but the public REST reference does not document how to encode a suggestion in `content.raw`. Keep `suggestedChanges=false` until an official contract or a stable live API test proves the payload. Render `suggestedFix` as a normal fenced code block in the interim so the proposed code is visible but is not falsely presented as directly applicable.

### Status equivalent

Use commit build statuses on the source commit. A stable key makes POST idempotently overwrite the same status, and `refname` must be the PR source branch for the status to associate with the pull request. Map states to `INPROGRESS`, `SUCCESSFUL`, and `FAILED`; Bitbucket has no neutral state, so represent a skipped task as `SUCCESSFUL` with a clear skipped description or omit the status according to one documented product policy.

Only the creator of a build status can update it unless the caller is a repository admin, so all create and update calls for a Pipr status key must use the same bot identity. See [Commit statuses](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/) and the [status author restriction](https://developer.atlassian.com/cloud/bitbucket/bitbucket-api-changes-commit-status/).

### Checkout and Pipelines

Bitbucket Pipelines provides `BITBUCKET_PR_ID`, `BITBUCKET_COMMIT`, `BITBUCKET_PR_DESTINATION_BRANCH`, `BITBUCKET_PR_DESTINATION_COMMIT`, `BITBUCKET_WORKSPACE`, and `BITBUCKET_REPO_SLUG`. Fetch the PR API object anyway so title, description, fork source, exact current head, and native URLs are authoritative. The variables are documented in [Variables and secrets](https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/).

Set `clone.depth: full`, because Bitbucket's default clone depth is 50 and the Trusted Base Config commit or merge base may otherwise be unavailable. See [Git clone behavior](https://support.atlassian.com/bitbucket-cloud/docs/git-clone-behavior/).

Traditional `pull-requests` pipelines run when a PR is created or updated but do not distinguish those actions. The newer `triggers` form exposes separate `pullrequest-created` and `pullrequest-updated` triggers and can launch target custom pipelines, which allows the generated launcher to set `PIPR_CHANGE_ACTION` exactly. Pull requests from forks do not trigger Bitbucket pull request pipelines. These constraints are documented in [Pipeline start conditions](https://support.atlassian.com/bitbucket-cloud/docs/pipeline-start-conditions/).

Source-controlled pipeline YAML and secured variables are not a sufficient untrusted-code boundary. Same-repository contributors who can edit the source branch can edit the build script that receives repository variables. A trusted webhook runner remains the production recommendation when the installation must review untrusted changes with write and model credentials.

## Azure DevOps adapter

### Native identity and event normalization

Use organization name, project name or ID, and target repository UUID as API coordinates. Azure pull request IDs are integers and map directly to `change.number`. Keep the source repository ID and URL separately for forks.

Azure Pipelines exposes PR variables only when the build was triggered by an Azure Repos branch-policy validation. Relevant values include `System.PullRequest.PullRequestId`, `SourceBranch`, `SourceCommitId`, `SourceRepositoryUri`, `TargetBranch`, `IsFork`, `System.TeamProject`, `System.TeamProjectId`, and `System.TeamFoundationCollectionUri`. Environment names replace periods with underscores and are uppercased by the agent, so parse the actual environment form in fixtures. See [Predefined variables](https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables?view=azure-devops).

Azure service hooks expose `git.pullrequest.created`, `git.pullrequest.updated`, and `ms.vss-code.git-pullrequest-comment-event`. The updated event can be filtered to source pushes with `notificationType=PushNotification`. Use the service-hook event ID and resource payload, not human-readable message strings. Azure's outgoing webhook documentation does not define an HMAC signature, so secure the receiver with strong Basic authentication or a secret custom header, then validate organization, project, subscription, and repository identifiers in the payload. Transient failures can be retried up to eight times, so dedupe on the event and notification identifiers. See [Service hook events](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops), [Webhooks](https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks?view=azure-devops), and [service hook troubleshooting](https://learn.microsoft.com/en-us/azure/devops/service-hooks/troubleshoot?view=azure-devops).

### Authentication and permissions

Inside Azure Pipelines, prefer the short-lived `System.AccessToken`, mapped explicitly into the container environment, and grant the project Build Service identity only the repository permissions required to read code, contribute to pull requests, manage PR threads, and create PR statuses. Azure documents the token and explicit YAML mapping in [Predefined variables](https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables?view=azure-devops) and job-token scope in [Access repositories and resources](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/access-tokens?view=azure-devops).

For a hosted webhook runner, prefer a Microsoft Entra service principal or managed identity added explicitly to the Azure DevOps organization and project. Azure DevOps permissions are managed in Azure DevOps, not through Entra application permissions. PATs should be limited to local development and prototypes. Microsoft recommends Entra identities over long-lived PATs in [service principal and managed identity guidance](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops) and [PAT guidance](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops).

Use REST API 7.1 consistently for the initial adapter because all required Git PR endpoints are released there. Do not implement new Azure DevOps OAuth registration; Microsoft has deprecated that flow for new applications in favor of Entra OAuth.

Command authorization does not have a simple role endpoint. Effective repository permission is derived from the Git Repositories security namespace, hierarchical tokens, user and group identity descriptors, inherited allow bits, and explicit deny bits. The adapter must either:

1. implement and thoroughly test effective permission evaluation for `GenericRead`, `GenericContribute`, `PullRequestContribute`, `EditPolicies`, and `ManagePermissions` using Security ACL APIs and group membership;
2. receive a signed authorization assertion from the trusted ingress;
3. disable commands initially.

Do not treat an ACL entry for the user alone as effective permission because Azure DevOps permissions are inherited through groups and denies can override allows. See the [security namespace reference](https://learn.microsoft.com/en-us/azure/devops/organizations/security/namespace-reference?view=azure-devops) and [ACL query API](https://learn.microsoft.com/en-us/rest/api/azure/devops/security/access-control-lists/query?view=azure-devops-rest-7.1).

### Change and iteration reads

Load the pull request with `GET .../_apis/git/repositories/{repositoryId}/pullrequests/{pullRequestId}?api-version=7.1`. The object supplies title, description, creator, source and target refs, repository identities, URL, and `lastMergeSourceCommit` and `lastMergeTargetCommit` data. See [Get Pull Request](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1).

List iterations and choose the latest iteration whose source commit matches the reviewed head. Iteration one is created with the PR and later pushes create later iterations. Fetch `GET .../iterations/{iterationId}/changes` with `compareTo=0` and follow `nextSkip` and `nextTop`. Each change supplies `changeTrackingId`, current path, original path, and change type. The maximum page size is 2000. See [Pull Request Iteration Changes](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1).

The Diff Manifest remains local Git output. The iteration changes are a native anchor index from path to `changeTrackingId` and iteration pair.

### Main Review Comment and prior state

Azure models every PR comment inside a thread. For the Main Review Comment:

- list all PR threads;
- find an unpositioned thread whose root comment is bot-authored and contains Pipr's main marker;
- update the root comment body through the thread comment update endpoint;
- otherwise create a thread with one text comment and no `threadContext`.

List threads with optional base and current iteration parameters so Azure tracks positions to the latest diff. Each thread includes comments, status, file positions, and PR iteration context. See [List Pull Request Threads](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1).

### Inline mapping

Create a positioned thread with `POST .../pullRequests/{pullRequestId}/threads?api-version=7.1`. Map a validated Pipr range as follows:

- prefix `filePath` with `/` consistently;
- Pipr `RIGHT`: set `rightFileStart` and `rightFileEnd`, leave left positions null;
- Pipr `LEFT`: set `leftFileStart` and `leftFileEnd`, leave right positions null;
- start positions use `offset: 1`;
- end offsets should use the end-of-line offset when known, or a tested sentinel accepted by the service;
- set `pullRequestThreadContext.changeTrackingId` from the latest iteration changes;
- set `iterationContext.firstComparingIteration=1` and `secondComparingIteration` to the latest reviewed iteration; use `1/1` for a newly created PR.

Do not copy `compareTo=0` from the iteration-changes read into the thread request. Live Azure DevOps Services testing returned HTTP 400 for `firstComparingIteration: 0`, accepted `1/1` for the initial PR, and accepted `1/2` and `1/3` after later pushes. The same tests proved right-side multiline, left-side delete, and split rename anchors. Retarget remains a mandatory live contract test. Do not infer `changeTrackingId` from local diff order.

Treat offsets as one-based UTF-16 code-unit positions. A live thread spanning through `café naïve 🙂` succeeded with end offset 14, matching the UI's JavaScript string offsets plus one. Keep this Unicode case in the provider contract suite so a future service or client change fails visibly.

The request and position fields are documented in [Create Pull Request Thread](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1). Azure states that `changeTrackingId` is required when the PR supports iterations.

Reply with `POST .../threads/{threadId}/comments`, setting `parentCommentId` to the root comment ID. Azure caps a thread at 500 comments. Resolve a finding by updating the thread status to `fixed`; do not delete comments. See [Create Pull Request Thread Comment](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1) and [Update Pull Request Thread](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/update?view=azure-devops-rest-7.1).

Azure's UI supports suggested changes, but the public REST thread documentation does not define a suggestion payload. Keep the capability disabled until an official or live-tested API contract exists, and render a plain code block in the meantime.

### Status equivalent

Use pull request statuses rather than commit statuses because Azure can associate the result with a specific PR iteration. Create a stable context such as genre `pipr` and name `pipr/<task>`, set `iterationId` to the reviewed iteration, and map conclusions to `pending`, `succeeded`, `failed`, and `notApplicable`. See [Create Pull Request Status](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/create?view=azure-devops-rest-7.1).

The Pipr adapter's current create/update check API should become a provider-neutral upsert. Azure status IDs are server-created, while GitLab and Bitbucket are more naturally keyed by name or key.

### Checkout and Pipelines

Azure Repos does not use the YAML `pr:` trigger. Configure a build validation branch policy on each target branch. The policy queues on PR creation and source updates; see [Build validation](https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies?view=azure-devops).

Use `checkout: self` with `fetchDepth: 0`. Azure may enable a depth-one shallow fetch for new pipelines, while Pipr needs the target commit and merge base for Trusted Base Config and the Diff Manifest. The checkout schema documents that `fetchDepth: 0` overrides the UI shallow-fetch setting in [steps.checkout](https://learn.microsoft.com/en-us/azure/devops/pipelines/yaml-schema/steps-checkout?view=azure-pipelines).

Set `persistCredentials: false` unless the adapter needs an authenticated Git fetch after checkout. Pass `System.AccessToken` only to the Pipr container process, not as a global environment variable for arbitrary preceding or following steps.

Fork security and source-authored YAML remain relevant. Azure recommends disabling fork builds or withholding secrets and normal permissions from them. A production installation that reviews forks should use a trusted launcher and ephemeral worker rather than relaxing those settings; see [Secure repository access](https://learn.microsoft.com/en-us/azure/devops/pipelines/security/secure-access-to-repos?view=azure-devops).

## Trusted webhook and runner architecture

Automatic same-repository review can be prototyped with native CI, but full Pipr parity should use a small trusted ingress and ephemeral runner:

```text
Provider webhook
  -> signature and replay validation
  -> native event schema parse
  -> installation and repository lookup
  -> permission assertion for comment actor, when required
  -> dedupe by provider delivery ID
  -> enqueue host run with provider, coordinates, event kind, and native IDs
  -> ephemeral Pipr container with short-lived or repository-scoped credentials
  -> fetch target and source commits
  -> load Trusted Base Config from target SHA
  -> run Pi against source head
  -> stale-head read
  -> adapter publication
```

The ingress should never execute PR-authored code. It validates metadata and launches the existing read-only Pi workspace flow. The runner should receive only one installation's credentials, use an ephemeral filesystem, and redact native payloads and tokens from logs.

Provider delivery protections:

- GitLab: validate current signing or secret-token headers, reject stale timestamps when signed delivery is enabled, and dedupe on the retry-stable webhook ID.
- Bitbucket Cloud: validate `X-Hub-Signature` HMAC and dedupe with the request, hook, and attempt headers plus a short-lived body digest.
- Azure DevOps: require Basic authentication or a secret custom header, validate event, subscription, organization, project, and repository identity, and dedupe on the event and notification IDs.

The ingress is required for `@pipr` commands and comment-reply verification because native GitLab, Bitbucket, and Azure PR pipeline triggers do not run a repository pipeline for a new review comment.

## Implementation sequence

This ordering lets one implementation effort build the shared seam once, then add providers without repeatedly changing core contracts.

1. **Neutralize host orchestration.** Add explicit provider selection, normalized event envelopes, structured coordinates, opaque native IDs, capability reporting, provider-neutral status naming, and provider-neutral logs. Port GitHub to the new contract without changing behavior.

2. **Build provider contract tests.** Define a shared adapter suite for event normalization, exact base/head values, stale-head failure before writes, main marker upsert, inline marker dedupe, partial retry, prior-state loading, replies, resolution, status transitions, pagination, and rate-limit retries.

3. **Implement GitLab first.** Its notes and discussions closely match Pipr's current model, and its documented multiline and suggestion contracts provide the cleanest validation of the generalized interface.

4. **Implement Azure DevOps second.** Add the iteration-index read and `changeTrackingId` mapping, then validate that the shared inline model can carry the extra native context without leaking it into Review Findings.

5. **Implement Bitbucket Cloud third.** Reuse the generalized publication path, then complete live spikes for multi-line anchors, renamed paths, REST-created suggestions, and effective command permissions.

6. **Add init artifacts.** Extend `pipr init --adapters` with `gitlab`, `bitbucket`, and `azure-devops`. Generate either a clearly labeled CI-only prototype or a trusted ingress installation file. Do not imply fork or command support when only the CI launcher is installed.

7. **Add webhook ingress if full parity is required.** Implement signature validation, delivery dedupe, installation credentials, permission assertions, and provider-to-runner dispatch. Keep it separate from adapter API code so self-hosted and hosted launchers can reuse the same runtime.

8. **Update product docs and language.** Replace GitHub-only claims in runtime, comments, trust/security, troubleshooting, and quickstart docs. Keep provider-specific installation pages separate while sharing one conceptual runtime guide.

## Verification strategy

### Unit and contract fixtures

For each provider, store redacted fixtures for:

- opened change request;
- source update;
- forked source;
- command comment;
- inline reply;
- malformed and unsupported event;
- deleted or renamed file;
- pagination with at least two pages;
- 401, 403, 404, 409, 429, and transient 5xx responses;
- stale native head;
- partially successful inline publication followed by retry;
- missing native diff version or iteration metadata.

Use zod at all event and API boundaries. Fixtures are native assets and can live in provider-local test fixture folders; executable tests stay in the nearest `tests/` folder under the source module.

The shared adapter contract should prove:

- event parsing never trusts missing required coordinates;
- base config is loaded before head checkout from the correct target SHA;
- no publication occurs when the current head differs;
- Main Review Comment marker upsert is idempotent;
- Inline Review Comments dedupe by finding marker and same-head overlap;
- a partial failure records posted markers and a retry posts only missing comments;
- only bot-owned marker comments are accepted as prior Pipr state;
- resolution is driven only by explicit verifier output;
- pagination reaches the marker on the last page;
- rate-limit retries respect provider headers and a bounded attempt budget;
- provider errors and logs contain no tokens or unredacted payload bodies.

### Inline golden matrix

Every provider needs request-payload goldens and live smoke tests for:

| Case | Expected behavior |
| --- | --- |
| One added line | Publish on new/right side |
| Multiple added lines | Publish exact same-side range or report unsupported capability |
| One deleted line | Publish on old/left side |
| Multiple deleted lines | Publish exact same-side range or report unsupported capability |
| Unchanged context | Publish only if both native coordinates are known |
| Rename with edit | Use provider's required old and new path values |
| Pure rename | Do not invent a line anchor |
| Binary or too-large file | Drop before provider API call |
| Head updated after review | Zero writes |
| Native diff version changed | Refresh native anchor data, then fail stale if head changed |

### Live provider smoke repositories

Create one private test repository per SaaS provider with:

- a bot or installation credential scoped only to the fixture repository;
- a change request containing added, removed, renamed, and multi-line changes;
- a second commit that makes an earlier inline comment outdated;
- a task status and aggregate status;
- one user reply and one explicit verifier resolution;
- rerun assertions that count exactly one Main Review Comment and no duplicate Inline Review Comments.

Record only redacted request shapes and resulting native IDs in test output. Do not commit tokens, full webhook headers, or user data.

### Repository checks

During implementation, run provider-local tests first. Before a PR, run `mise run check`. Because adapter work changes Docker packaging, workflow fixtures, event handling, and CLI mapping, also run `mise run check-actions`. Verify the image can run both `pi --help` and `pipr action --help`, then run the three provider smoke repositories against the exact image digest under review.

## Acceptance criteria for each adapter

An adapter is production-ready only when all of these are true:

- the supported provider product and minimum version are explicit;
- provider selection cannot silently choose another host;
- event and API payloads are schema-validated;
- the exact target SHA and source head SHA are established from the provider API;
- Trusted Base Config is loaded from the target SHA;
- the local checkout contains base, merge base, and exact head;
- the stale-head guard performs zero writes on mismatch;
- Main Review Comment create, update, and last-page lookup pass live tests;
- added and deleted Inline Review Comments pass live tests;
- multi-line and rename behavior is either proven or exposed as unsupported;
- prior state, replies, and thread resolution pass live tests for claimed capabilities;
- statuses are idempotent and attach to the correct source head or iteration;
- command permission behavior is effective-permission based or commands are disabled;
- rate limits, pagination, retries, and partial publication are tested;
- fork and secret behavior is documented and enforced;
- `pipr init` generates a configuration whose security properties match its claims;
- no source-authored pipeline receives production write or model credentials under the supported threat model.

## Required decisions before turning this into tickets

1. **Adapter milestone:** decide whether the first release means automatic reviews only or full parity including commands and reply verification. Full parity includes the webhook ingress and its deployment model.

2. **Execution product:** decide whether Pipr will ship provider CI templates, a hosted installation service, a self-hosted webhook runner, or both. CI templates alone cannot meet the current untrusted-PR security model.

3. **Bitbucket product:** confirm Bitbucket Cloud is the intended target. If Data Center is required, plan it as a fourth adapter.

4. **Server compatibility:** choose minimum GitLab Self-Managed and Azure DevOps Server versions or explicitly support SaaS first. API capabilities such as GitLab file positions and current webhook signatures vary by server version.

5. **Command authorization:** choose whether stronger admin credentials are acceptable for Bitbucket and whether Azure effective ACL evaluation belongs in Pipr or in the trusted ingress.

6. **Suggested changes:** decide whether provider parity requires one-click suggestions. GitLab is documented; Bitbucket and Azure need a supported REST contract or a product downgrade to visible code blocks.

7. **Status semantics:** define one provider-neutral mapping for neutral or skipped tasks where the native provider lacks a neutral state.

Once these decisions are made, the implementation sequence above can be converted directly into tracer-bullet tickets without reopening the provider research.
