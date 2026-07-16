# Security policy

Use this policy to report vulnerabilities in Pipr. Do not open a public issue
for security reports.

## Supported versions

Pipr is early. Security fixes target the default branch and the current release
line until the project starts maintaining separate release branches.

Pipr ships through:

- CLI binaries attached to GitHub Releases
- `@usepipr/sdk`, `@usepipr/runtime`, and `@usepipr/cli` on npm
- the Docker Action image on GHCR

## Reporting a vulnerability

Report security issues through
[GitHub Security Advisories](https://github.com/somus/pipr/security/advisories/new)
for `somus/pipr`.

Include:

- affected behavior or file path
- steps to reproduce
- expected impact
- any suggested fix or mitigation

## Scope

Relevant security areas include:

- hosted integration and webhook execution
- change request trust boundaries
- provider secret handling
- Pi tool access
- Diff Manifest path handling
- code host comment publishing
- package release and Docker Action publishing

Do not include raw provider keys, tokens, private repository contents, or other
sensitive data in the report unless GitHub Security Advisories requires it for
reproduction.
