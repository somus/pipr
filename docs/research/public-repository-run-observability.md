# Public Repository Run Observability

Status: Recommendation
Researched: 2026-07-27

## Verdict

Pipr must not upload plaintext diagnostic Run Bundles to the native artifact
store of a public repository. A provider credential used by `pipr runs` is only
a retrieval credential; it cannot make an otherwise public artifact private.

For public repositories, Pipr should publish content-free metadata by default.
Diagnostic capture should require one of two explicit secure sinks:

1. Encrypt the complete archive to repository-configured public-key recipients
   before uploading it as a native CI artifact.
2. Upload it to customer-owned private object storage through a short-lived,
   write-only OIDC identity, then authorize readers through that storage
   provider.

The first option is the appropriate provider-neutral default because it keeps
Pipr backend-free, works for fork pull requests without exposing a secret, and
preserves native artifact retention and discovery. The second option provides
central revocation and audit for organizations willing to configure cloud
storage.

## Why native artifact authorization is insufficient

The four hosts do not provide a common owner-only access boundary for artifacts
attached to public repositories:

- GitHub's Actions artifact API allows artifact metadata and archive downloads
  for public resources without authentication. A token with Actions read
  permission is required for private resources, but requiring that token in the
  Pipr CLI cannot constrain direct access to the public API.
  [GitHub Actions artifact API](https://docs.github.com/en/rest/actions/artifacts)
- GitLab defaults `artifacts:access` to `all`, which makes artifacts in public
  pipelines downloadable by anyone. `developer` and `maintainer` restrictions
  are available, although job-token access is governed separately by CI/CD
  visibility.
  [GitLab CI YAML: `artifacts:access`](https://docs.gitlab.com/ci/yaml/#artifactsaccess)
- Azure DevOps currently says a public project cannot selectively keep build
  artifacts private. Azure is retiring public projects, but existing public
  projects remain relevant during the transition. In ordinary projects,
  pipeline Readers have `View builds`, so even private-project access is broader
  than repository ownership.
  [Azure public-project visibility](https://learn.microsoft.com/en-us/azure/devops/organizations/projects/make-project-public?view=azure-devops),
  [Azure Pipeline permissions](https://learn.microsoft.com/en-us/azure/devops/pipelines/policies/permissions?view=azure-devops)
- Bitbucket Downloads are repository-scoped: the API uses repository read and
  write scopes and documents no per-download owner-only ACL. Public repositories
  are accessible to anyone, so Pipr should not treat Downloads as a separate
  confidential store.
  [Bitbucket Downloads API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-downloads/),
  [Bitbucket repository access](https://support.atlassian.com/bitbucket-cloud/docs/grant-repository-access-to-users-and-groups/)

GitLab's `artifacts:access: maintainer` is useful defense in depth and should be
generated, but it cannot be the cross-provider design.

## Patterns used by agent observability systems

Agent observability systems combine content minimization with an authenticated
storage boundary. They do not assume that tracing data is harmless:

- LangSmith can hide or transform trace inputs, outputs, and metadata before
  transmission, and supports per-request conditional tracing. It also applies
  workspace RBAC and bounded trace retention.
  [LangSmith sensitive-data masking](https://docs.langchain.com/langsmith/mask-inputs-outputs),
  [conditional tracing](https://docs.langchain.com/langsmith/conditional-tracing),
  [RBAC](https://docs.langchain.com/langsmith/rbac),
  [retention](https://docs.langchain.com/langsmith/administration-overview)
- Langfuse binds API keys to a project and enforces project roles server-side,
  so ingestion credentials and human trace access are scoped to an authenticated
  project rather than the application's public deployment surface.
  [Langfuse data isolation](https://langfuse.com/security/data-isolation)
- Phoenix requires bearer credentials for trace ingestion and API access when
  authentication is enabled, and supports OAuth-based group and role controls
  for readers.
  [Phoenix authentication](https://arize.com/docs/phoenix/deployment/authentication)

OpenTelemetry makes the same separation. It recommends a Collector for
encryption and sensitive-data filtering, provides attribute/filter/redaction
processors, and treats privacy-risk attributes as opt-in. Pipr's existing
content-free OTLP allowlist follows this pattern and should remain independent
from diagnostic artifact capture.
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/),
[handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/),
[attribute requirement levels](https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/)

## Recommended Pipr design

### Public metadata plane

When repository visibility is public or cannot be determined, the default
hosted capture mode should be `metadata`. The uploaded data may contain run
identity, provider coordinates, phase timings, retry counts, resource usage,
outcomes, hashes, artifact sizes, and content-free error categories. It must
exclude prompts, model output, source and diff text, stderr bodies, environment
values, tool payloads, validation bodies, and publication bodies.

This plane remains discoverable through native CI APIs and can explain most
latency and lifecycle failures without exposing repository-derived content.
OTLP remains content-free regardless of repository visibility.

### Encrypted native artifact

An explicit diagnostic mode should assemble and redact the bundle, archive it,
and encrypt the entire archive before the upload step can see it. A public-key
recipient is safe to keep in repository configuration; no decryption secret is
available to the CI job or an untrusted fork.

The age format is a suitable implementation option: it encrypts to one or more
public recipients and requires the corresponding identities for decryption.
Its documented streaming CLI also fits Pipr's bounded archive flow.
[age documentation](https://github.com/FiloSottile/age)

The provider artifact should contain only:

- the ciphertext;
- a small, content-free envelope with schema version, execution ID, ciphertext
  size and SHA-256, encryption scheme, and capture status.

`pipr runs list` can use the envelope and provider run metadata. `show` and
`download` should report `locked` until a local identity decrypts the archive,
then perform the existing schema, path, size, and hash validation. Multiple
recipients support teams, but removing a recipient protects only future
archives; organizations needing central revocation should use the private-sink
mode.

Encryption failure must fail closed for publication: the review may continue,
but Pipr must upload no diagnostic plaintext. It should upload only metadata
with `encryption-failed`, warn prominently, and remove the temporary plaintext
bundle.

### Customer-owned private sink

Organizations may instead configure a private object store or authenticated
observability backend. CI should exchange the host's OIDC token for a
short-lived role limited to `PutObject` under one repository/run prefix, with no
list, read, overwrite, or delete permission. Humans retrieve through their
normal cloud identity, where RBAC, audit, retention, and KMS policy are
independent from public repository visibility.

All four CI providers support secretless workload identity:

- [GitHub Actions OIDC claims and trust conditions](https://docs.github.com/en/actions/reference/security/oidc)
- [GitLab CI ID tokens](https://docs.gitlab.com/ci/secrets/id_token_authentication/)
- [Azure Pipelines workload identity federation](https://learn.microsoft.com/en-us/azure/devops/pipelines/release/configure-workload-identity?view=azure-devops)
- [Bitbucket Pipelines OIDC](https://support.atlassian.com/bitbucket-cloud/docs/integrate-pipelines-with-resource-servers-using-oidc/)

Trust policy must bind stable repository/project identity and the intended
workflow or pipeline. GitHub explicitly requires claim conditions so untrusted
repositories cannot obtain the cloud role; GitLab recommends stable project IDs
and a supply-chain review. The upload identity should remain write-only because
pull-request code is untrusted even when the workflow definition comes from the
base repository.

## Required policy changes

The accepted observability ADR currently says provider artifacts retain their
native authorization boundaries. That is accurate but insufficient: on a
public repository, the native boundary can be anonymous read access. Before
release, Pipr should amend the decision as follows:

- Detect repository visibility; treat missing or indeterminate visibility as
  public.
- Default public hosted runs to metadata capture.
- Refuse plaintext diagnostic upload for public or indeterminate repositories.
- Support recipient encryption as the backend-free diagnostic path.
- Keep private OIDC storage as an optional organizational integration.
- Generate `artifacts:access: maintainer` on GitLab as defense in depth.
- Preserve redaction and minimization before encryption, because ciphertext may
  later be decrypted or copied.
- State clearly that provider tokens discover artifacts, while the decryption
  identity or private-store RBAC authorizes diagnostic content.

This changes the security boundary without adding a Pipr-hosted authorization
service or an eval engine.
