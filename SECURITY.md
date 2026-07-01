# Security Policy

## Supported versions

pipr is early. CLI binaries ship through GitHub Releases, the config SDK ships as `@usepipr/sdk` on npm, and the Docker Action image ships through GHCR. Security fixes target the default branch and current release line until the project starts maintaining separate release branches.

## Reporting a vulnerability

Please report security issues through GitHub Security Advisories for `somus/pipr`.

Do not open a public issue for vulnerabilities. Include:

- affected behavior or file path
- steps to reproduce
- expected impact
- any suggested fix or mitigation

## Scope

Relevant security areas include GitHub Action execution, pull request trust boundaries, provider secret handling, Pi tool access, Diff Manifest path handling, and GitHub comment publishing.
