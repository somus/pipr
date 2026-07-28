# ADR 0009: Protected public-repository run observability

## Status

Accepted

## Context

ADR 0008 relied on provider artifact authorization to protect diagnostic Run Bundles. That
assumption does not hold consistently for public repositories: provider APIs, project settings,
and artifact defaults can allow people without repository write access to fetch CI artifacts.
Redaction reduces accidental disclosure, but diagnostic bundles still contain repository source,
prompts, visible model output, validation evidence, and publication details.

The public metadata needed for deterministic lifecycle and timing diagnosis is much narrower than
the evidence needed for deep debugging. Provider credentials can authorize artifact discovery
without being a safe authorization boundary for diagnostic content.

This decision treats provider-visible artifacts as public and requires a separate authorization
boundary for diagnostic content.

## Decision

Native CI publishes a versioned protected package with two independent planes:

- `metadata.tar.gz` contains a fixed, content-free projection suitable for provider-visible
  artifacts.
- `diagnostic.tar.gz.age`, when configured, contains the full redacted Run Bundle encrypted to one
  or more X25519 age recipients.

`envelope.json` binds both files to the execution ID with byte sizes and SHA-256 hashes. It also
records whether diagnostics are available, were not captured, failed encryption, or exceeded the
size limit. Pipr validates the envelope, exact file set, hashes, schemas, archive paths, symlinks,
and expansion limits before returning data.

Native CI writes plaintext capture data to a private temporary directory outside the provider
artifact path. Packaging projects public metadata, encrypts diagnostics when recipients are
configured, moves only the protected package into `.pipr-runs`, and removes plaintext in every
outcome. Confidentiality fails closed: encryption or package validation failures may remove
diagnostic availability, but cannot publish plaintext.

Pipr provides first-class artifact upload, discovery, and download only for GitHub Actions. The
provider-neutral recorder still captures GitLab, Azure DevOps, and Bitbucket runs, but generated CI
for those hosts does not upload observability artifacts and `pipr runs` does not call their remote
APIs. Teams can persist a protected package through custom CI and open it with `pipr runs inspect`.
Trusted webhook filesystem stores remain available on every supported host.

Without `PIPR_RUN_AGE_RECIPIENTS`, native CI defaults to metadata capture. With valid recipients it
defaults to encrypted diagnostics. `PIPR_RUN_CAPTURE` can explicitly select `off`, `metadata`, or
`diagnostic`, but diagnostic mode without a recipient still publishes metadata only.

GitHub credentials remain discovery credentials. An age identity authorizes diagnostic
decryption. `pipr runs show` falls back to metadata when an identity is unavailable, while
`pipr runs download` requires a matching identity for an encrypted diagnostic bundle.

Trusted webhook stores and opt-in local captures remain validated private plaintext bundles under
filesystem authorization. The recorder, content-free OTLP policy, `RunArchiveSource` boundary, and
post-run model from ADR 0008 remain unchanged. The only remote `RunArchiveSource` implementation is
GitHub; the filesystem source and package validation remain provider-neutral.

## Consequences

Public GitHub artifacts can expose timing, lifecycle, usage, resource, status, hash, and size
metadata without exposing repository or model content. Possession of a provider token does not
grant diagnostic access; teams can give a coding agent an identity independently from its provider
credential.

`PiprResult` may expose bounded, content-free aggregates that are also safe for the public metadata
plane, including cache token totals and current-run diff context coverage counts. Exact paths and
range IDs remain diagnostic content and require the protected plane.

Key rotation is prospective. Adding a new recipient protects future bundles but does not re-encrypt
existing artifacts, so old identities must be retained for the artifact retention window when old
runs still need to be opened.

Pipr does not detect repository visibility, host an authorization service, add private object
storage, or support passphrase or SSH recipients.
