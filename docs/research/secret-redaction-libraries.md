# Secret redaction options for Pipr

Research date: 2026-07-13

## Recommendation

Use [Betterleaks](https://github.com/betterleaks/betterleaks) as an offline, container-bundled scanner at Pipr's final publication boundary. Keep Pipr's exact-value masking for known environment and resolved secrets, and keep the current cheap heuristic for synchronous logs until there is a separate logging design.

Betterleaks is the best fit because it:

- is maintained by the original Gitleaks authors and is still accepting detection and engine work;
- has a dedicated `stdin` command, so model output never needs to be written to disk;
- emits JSON findings with start/end line and column data while `--redact=100` prevents its own report from repeating the secret;
- ships as a single MIT-licensed binary for Alpine-compatible container use;
- keeps live credential validation disabled unless `--validation` is explicitly passed, so the default path is offline;
- supports contextual filters, entropy checks, token-efficiency filtering, and 325 rules in the v1.6.1 embedded configuration.

Do not treat it as a drop-in replacement for all current redaction. Pipr has two different workloads:

1. Known runtime secrets must be removed synchronously from logs. Pipr already collects values from sensitive environment variables and `ctx.secret(...)`, then removes exact matches in `packages/runtime/src/shared/logging.ts`.
2. Publication-bound text must be checked before it becomes a PR comment, suggested patch, verifier reply, command response, dropped-finding record, or Check Run summary. This is where a provider-aware scanner materially improves the current single regex in `packages/runtime/src/shared/redaction.ts`.

A CLI process per log field would add hundreds of milliseconds and force asynchronous behavior through a synchronous logging API. One scan per completed publication payload is both safer and cheaper. Local `pipr review` output retains heuristic masking, while synchronous Action logs retain exact-value and heuristic masking. The Betterleaks subprocess is limited to the Docker Action's publication path.

## Current Pipr boundary

The existing implementation is layered, but the heuristic layer is narrow:

- `packages/runtime/src/shared/logging.ts` registers sensitive environment values and resolved secrets, then performs exact string replacement before emitting log records.
- `packages/runtime/src/shared/redaction.ts` applies one regex for unknown token-like strings containing `secret`, `token`, or `api_key`.
- `packages/runtime/src/review/comment.ts` applies that regex to the main review body and inline finding bodies, and drops a suggested fix if the regex changes it.
- `packages/runtime/src/review/review-stats.ts` adds a separate provider-pattern and high-entropy guard for model telemetry.

The main residual risk is model-generated publication text containing a credential that is not one of the registered runtime values and does not contain the literal words recognized by the generic regex. A GitHub PAT, Slack token, private key, database URL, or provider key can cross that path without matching `redactPotentialSecrets`.

## Candidate comparison

| Candidate | Maintenance as of research date | Arbitrary text input | Machine-usable locations | Container cost | License | Pipr fit |
| --- | --- | --- | --- | --- | --- | --- |
| [Betterleaks v1.6.1](https://github.com/betterleaks/betterleaks/releases/tag/v1.6.1) | Released 2026-06-30; active successor maintained by the original Gitleaks team | Native `stdin` | JSON includes start/end line and column; reports can redact secret values | Linux x64 archive 9.8 MB; tested Darwin binary 21.7 MB unpacked | MIT | Best fit |
| [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) | Released 2026-03-21, but declared feature-complete; future work moved to Betterleaks | Native `stdin` | JSON includes start/end line and column; `--redact` supported | Linux x64 archive 8.2 MB | MIT | Stable fallback, weaker future rule growth |
| [Kingfisher v1.106.0](https://github.com/mongodb/kingfisher/releases/tag/v1.106.0) | Released 2026-07-08; 96 releases and active roadmap | File/directory-oriented scanning; stdin is documented for direct validation, not general scanning | JSON/SARIF reports | Linux x64 archive 15.1 MB plus Vectorscan cache behavior | Apache-2.0 | Strong scanner, awkward runtime-text interface |
| [TruffleHog v3.95.9](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.95.9) | Released 2026-07-09; heavy active development | Native `stdin` | JSON output, but the public library API is explicitly unstable | Linux x64 archive 33.6 MB; much larger unpacked binary | AGPL-3.0 | Broad detection, but oversized and adds license/API risk |
| [Secretlint v13](https://github.com/secretlint/secretlint) | v13.0.2 published in 2026; active JavaScript project | In-process `lintSource` API and CLI stdin | In-process findings include character ranges | Tested dependency tree 1.4 MB | MIT | Convenient, but materially narrower detection |
| [detect-secrets v1.5](https://github.com/Yelp/detect-secrets) | Latest tagged release 2024-05-06 | Python API and file-oriented CLI | Plugin findings identify locations | Adds Python and package dependencies to Alpine | Apache-2.0 | Mature plugin design, poor container/runtime fit |
| [`fast-redact`](https://github.com/davidmarkclements/fast-redact) / [`@pinojs/redact`](https://github.com/pinojs/redact) | Maintained object-redaction libraries | Objects with known property paths | Not applicable | Small npm dependencies | MIT | Solves structured field masking, not secret discovery in Markdown or patches |

### Betterleaks

Betterleaks is a continuation of the Gitleaks approach rather than an unrelated young package. Its project describes fast RE2 scanning, Aho-Corasick keyword prefilters, contextual Expr filters, token-efficiency filtering, optional validation, and portable single binaries. Its [`stdin` mode](https://github.com/betterleaks/betterleaks/blob/main/docs/scanning.md) matches Pipr's model-output boundary directly.

The tested v1.6.1 binary produced redacted JSON with `RuleID`, `StartLine`, `EndLine`, `StartColumn`, and `EndColumn`. On a 757-byte synthetic input it took about 278 ms cold and found a Slack token plus a generic credential. Its embedded default configuration contains 325 rules. The Darwin arm64 artifact's SHA-256 matched the digest published on its immutable GitHub release.

There are two caveats. First, its default rules did not flag Pipr's deliberately fake strings such as `pipr_eval_secret_do_not_repeat_12345`; those strings are caught by Pipr's current heuristic. Second, the upstream project recommends owning a reviewed configuration in production instead of silently inheriting new defaults. Pipr should pin both the binary digest and a tested rule configuration.

### Gitleaks

Gitleaks has the cleanest mature CLI contract: [`stdin`, redacted output, JSON reports, and exact source columns](https://github.com/gitleaks/gitleaks). It is smaller than Betterleaks and has much wider deployment history.

It is no longer the best new dependency because the maintainer states that Gitleaks is feature-complete and will receive security fixes while feature work moves to Betterleaks. Pipr needs provider patterns to evolve as credential formats change, so maintenance of the rule corpus matters more than a modest binary-size saving.

### Kingfisher

Kingfisher is the strongest alternative for repository scanning. The project currently advertises [958 built-in rules, parser-aware verification, JSON/SARIF output, and signed release provenance](https://github.com/mongodb/kingfisher). It is actively maintained by MongoDB and Apache-2.0 licensed.

Its documented runtime interface is a mismatch. General scanning is path-oriented, while stdin is documented for validating an already-known secret. Using it for each publication would require a temporary file or an unverified library integration, and its compiled Vectorscan rule cache adds container state that Betterleaks does not require for this small-input path.

### TruffleHog

TruffleHog offers [more than 700 credential detectors, stdin scanning, and optional live verification](https://github.com/trufflesecurity/trufflehog). It is the most actively released candidate and has the broadest provider-verification story.

It is a poor default for Pipr because the binary is several times larger, the project says its public library API has no stability guarantees, and distributing the AGPL-3.0 binary in Pipr's image adds compliance work. Verification also makes outbound requests with detected credentials; Pipr does not need that to redact publication text and should keep scanning offline.

### Secretlint

Secretlint is the best pure JavaScript option. Its [`lintSource` API](https://github.com/secretlint/secretlint/blob/master/packages/%40secretlint/core/src/index.ts) accepts in-memory text and returns exact character ranges. The recommended preset is bundled for load performance, and the package worked under Bun 1.3.14 despite declaring Node 22 or newer.

The local probe was not convincing enough for a security boundary. The recommended preset detected a PostgreSQL credential URL but missed the synthetic GitHub, OpenAI, Anthropic, AWS, JWT, and generic assignment samples used in the probe. Some provider samples were intentionally non-live and may not satisfy exact production formats, but Betterleaks offers a broader, more configurable corpus with comparable stdin integration.

## Proposed Pipr integration

### 1. Preserve exact-value masking

Keep the synchronous `RuntimeActionLog` secret registry. Exact matching is the highest-confidence defense for values Pipr actually possesses, and it avoids false positives. GitHub's own runner uses the same basic model through `add-mask`/`core.setSecret`, but runner masking only protects workflow logs; it does not sanitize PR comments created through the GitHub API.

Consider replacing the repeated `split(...).join(...)` loop only if profiling shows a problem. The expected secret set is small, so a multi-pattern matcher is unnecessary until evidence says otherwise.

### 2. Add one asynchronous publication scan

At the async boundary immediately before publication planning:

1. Normalize and bound the candidate main body, inline bodies, suggested fixes, and model identifiers as today.
2. Encode publication bodies and check summaries into one framed stdin payload with segment IDs that cannot be interpreted as user content.
3. Run a pinned `betterleaks stdin` process with `--no-banner --redact=100 --report-format=json --report-path=- --max-decode-depth=0 --max-archive-depth=0` and no `--validation` flag.
4. Parse the report with Zod and map locations back to segments.
5. Replace detected spans in prose with `[redacted secret]`; drop any suggested fix containing a finding rather than trying to repair code.
6. Run the existing heuristic afterward so current pseudo-secret behavior and synchronous log protection do not regress.

Disabling recursive decoding for the first version keeps reported offsets directly mappable to the original text. A later change can detect encoded findings and drop the containing segment wholesale.

Treat exit code `1` as "findings present", `0` as clean, and every other exit, timeout, malformed report, or missing binary as a publication failure. Falling back to unscanned publication would turn a defense failure into a credential leak.

### 3. Pin and verify the container artifact

Add the Linux binary in a dedicated Docker build step with:

- an exact Betterleaks version;
- the upstream SHA-256 digest checked during the build;
- the upstream MIT license retained in the image or distribution notices;
- `betterleaks version` and a deterministic stdin fixture in `mise run check-actions`;
- a trusted config path that extends the rules embedded in the digest-pinned binary, rather than reading scanner settings from the change request worktree.

For v1.6.1, the official Linux x64 archive is 9,791,446 bytes with SHA-256 `fbefc700a0bd4522cc952dd2a8f259cdb80526d7e60114aca19bb2d6fdc80f81`. The arm64 archive is 8,997,829 bytes with SHA-256 `bab9688ba968264ace67b608fc7a7d8f5e61218cde70029d32cbc894e3808fdf`.

## Verification plan

Before adopting the scanner, build a redaction corpus that exercises the actual publication contract:

- every currently supported provider credential family and generic secret assignment;
- registered secrets with punctuation, JSON escaping, Unicode neighbors, and substrings;
- main comments, inline comments, suggested fixes, model telemetry, and Pi failure snippets;
- safe long identifiers, commit SHAs, hashes, fixture placeholders, package integrity values, and model names;
- CRLF, multiline private keys, URLs, Markdown fences, and overlapping findings;
- scanner timeout, missing binary, exit-code handling, malformed JSON, and oversized output.

Run the same corpus against the current regex and Betterleaks, record which layer detected each case, and keep it as a version-upgrade gate. Detection libraries still use rules and heuristics; the corpus is what prevents a rule update from quietly changing Pipr's publication behavior.

## Decision

Adopt Betterleaks for asynchronous scanning of publication-bound model output, retain exact-value masking and the current heuristic for logs, and pin the binary plus its architecture-specific digest. The trusted Pipr config should explicitly enable the pinned binary's embedded defaults; choose Gitleaks instead only if Pipr values longer operational history more than continued detector development.
