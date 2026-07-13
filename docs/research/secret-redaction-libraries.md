# Secret redaction options for Pipr

Research date: 2026-07-13

## Decision

Do not bundle a heuristic secret scanner in Pipr. Mask only exact values for credentials Pipr receives at runtime, including sensitive environment variables and values resolved through `ctx.secret(...)`.

Repository scanning and runtime masking solve different problems. A repository scanner detects credentials already committed to source so maintainers can revoke and remove them. Pipr's runtime masking prevents credentials supplied to the Action from being copied into logs or code-host publications. Scanning every model publication adds a binary, subprocess lifecycle, failure policy, coordinate mapping, image size, and detector false positives without repairing the original repository disclosure.

## Evaluated scanners

| Candidate | Maintenance as of research date | Text input | Distribution cost | License | Assessment |
| --- | --- | --- | --- | --- | --- |
| [Betterleaks v1.6.1](https://github.com/betterleaks/betterleaks/releases/tag/v1.6.1) | Released 2026-06-30; active successor maintained by the original Gitleaks team | Native `stdin` with JSON locations | Linux x64 archive 9.8 MB | MIT | Best technical fit, but the publication-scanning boundary does not justify its operational cost |
| [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) | Released 2026-03-21; feature-complete with security maintenance | Native `stdin` with redacted JSON reports | Linux x64 archive 8.2 MB | MIT | Mature alternative, with the same product-boundary cost |
| [Kingfisher v1.106.0](https://github.com/mongodb/kingfisher/releases/tag/v1.106.0) | Released 2026-07-08; actively maintained | General scanning is path-oriented | Linux x64 archive 15.1 MB plus rule-cache state | Apache-2.0 | Strong repository scanner, awkward for runtime publication text |
| [TruffleHog v3.95.9](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.95.9) | Released 2026-07-09; actively maintained | Native `stdin` and optional verification | Linux x64 archive 33.6 MB | AGPL-3.0 | Broad detection, but too large and adds license and verification risk |
| [Secretlint v13](https://github.com/secretlint/secretlint) | v13.0.2 published in 2026; actively maintained | In-process `lintSource` API | Tested dependency tree 1.4 MB | MIT | Convenient, but materially narrower detection in local probes |
| [detect-secrets v1.5](https://github.com/Yelp/detect-secrets) | Latest tagged release 2024-05-06 | Python API and file-oriented CLI | Adds Python and packages to Alpine | Apache-2.0 | Mature plugin design, poor container fit |

Object redaction packages such as `fast-redact` and `@pinojs/redact` were also considered. They mask known object paths rather than discovering credentials in Markdown or patches, so they do not replace exact-value masking or repository secret scanning.

## Why publication scanning was rejected

Betterleaks was the strongest candidate for an offline publication scanner. It provides a maintained rule corpus, a portable binary, stdin scanning, and redacted JSON findings with source coordinates. A prototype pinned the v1.6.1 binary and architecture-specific checksums, mapped UTF-8 byte coordinates back to publication fields, and failed closed when the scanner was unavailable.

The prototype prevented review comments from repeating credentials already present in model-visible source, but it did not prevent the original repository disclosure or remove the credential from Git history. The remaining containment benefit did not justify maintaining the binary supply chain, subprocess timeout and error behavior, publication-field mapping, Docker contract, and detector policy.

## Retained boundary

Pipr keeps a small exact-value registry:

- Sensitive environment-variable values are registered when the runtime starts.
- Values resolved through `ctx.secret(...)` are registered before task execution continues.
- Registered values are replaced in Action logs and publication-bound review text.
- Values shorter than four characters from dynamic registration are ignored to avoid replacing ordinary text fragments.

Pipr does not inspect repository content for unknown credentials. Repositories should run a dedicated secret scanner in CI and revoke any credential found in source, regardless of whether Pipr reviews the change.
