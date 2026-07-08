# Changelog

This changelog is generated from Conventional Commits by Release Please.
Published releases and downloadable CLI artifacts are available on
[GitHub Releases](https://github.com/somus/pipr/releases).

## [0.3.2](https://github.com/somus/pipr/compare/v0.3.1...v0.3.2) (2026-07-08)


### Features

* improve review presentation recipes ([#36](https://github.com/somus/pipr/issues/36)) ([fa1fc2a](https://github.com/somus/pipr/commit/fa1fc2af54160e6ffb8dc1a68ba223d5c529c0c5))

## [0.3.1](https://github.com/somus/pipr/compare/v0.3.0...v0.3.1) (2026-07-08)


### Features

* **cli:** show update notices ([#31](https://github.com/somus/pipr/issues/31)) ([2f4112a](https://github.com/somus/pipr/commit/2f4112a44226d63d0e71844d3e09c05fb3a9f608))


### Bug Fixes

* **ci:** harden flaky failure paths ([#34](https://github.com/somus/pipr/issues/34)) ([73eb372](https://github.com/somus/pipr/commit/73eb3721bf0d9c661a9afce111e4cd8ee4ccc1c5))
* **runtime:** harden redaction and inline dedupe ([#33](https://github.com/somus/pipr/issues/33)) ([15b305e](https://github.com/somus/pipr/commit/15b305e625503f65d1f3be058f6add7993305f8d))

## [0.3.0](https://github.com/somus/pipr/compare/v0.2.2...v0.3.0) (2026-07-07)


### ⚠ BREAKING CHANGES

* remove legacy SDK tool execute compatibility ([#27](https://github.com/somus/pipr/issues/27))

### Features

* **cli:** add version and update commands ([#30](https://github.com/somus/pipr/issues/30)) ([63f3869](https://github.com/somus/pipr/commit/63f3869b3f259a3b6ecb4b25726c845f998224fe))


### Bug Fixes

* **docs:** serve root shell in docs image ([#29](https://github.com/somus/pipr/issues/29)) ([587754a](https://github.com/somus/pipr/commit/587754a9f96214387fabd989365de1043db8b644))
* **runtime:** tighten suggested change publication ([#25](https://github.com/somus/pipr/issues/25)) ([e3d3646](https://github.com/somus/pipr/commit/e3d364623028783fc45ef6154f718a5a8d997673))


### Code Refactoring

* remove legacy SDK tool execute compatibility ([#27](https://github.com/somus/pipr/issues/27)) ([baf2dc3](https://github.com/somus/pipr/commit/baf2dc3d9bdee911f87b7396d2ae7f7e4592621d))

## [0.2.2](https://github.com/somus/pipr/compare/v0.2.1...v0.2.2) (2026-07-06)


### Features

* harden review prompts and evals ([#22](https://github.com/somus/pipr/issues/22)) ([7415e3b](https://github.com/somus/pipr/commit/7415e3b932e925b3c41315f275706c0e373e9d96))

## [0.2.1](https://github.com/somus/pipr/compare/v0.2.0...v0.2.1) (2026-07-06)


### Features

* **cli:** bundle pipr setup skill ([#18](https://github.com/somus/pipr/issues/18)) ([801957d](https://github.com/somus/pipr/commit/801957d8ea8ed5d04ddeaf8efa8d122c174e7c83))
* make review runs retry-safe ([#21](https://github.com/somus/pipr/issues/21)) ([98dc50f](https://github.com/somus/pipr/commit/98dc50f10d24e0f4c00d49fc2df951d4b90f953a))

## [0.2.0](https://github.com/somus/pipr/compare/v0.1.3...v0.2.0) (2026-07-02)


### ⚠ BREAKING CHANGES

* pipr init --types-only and --no-types are removed and generated .pipr/types/pipr-sdk.d.ts is no longer written; types come from the installed @usepipr/sdk package.
* structure runtime action logging ([#10](https://github.com/somus/pipr/issues/10))
* consolidate public API contracts ([#9](https://github.com/somus/pipr/issues/9))

### Features

* consolidate public API contracts ([#9](https://github.com/somus/pipr/issues/9)) ([01db150](https://github.com/somus/pipr/commit/01db1506ff9af35864f130c27a6d0b2df37fdbe1))
* support installable npm dependencies in .pipr config ([#14](https://github.com/somus/pipr/issues/14)) ([97794bc](https://github.com/somus/pipr/commit/97794bc8c9bd588e69e2935de4f443e704779cd6))


### Code Refactoring

* structure runtime action logging ([#10](https://github.com/somus/pipr/issues/10)) ([64addf1](https://github.com/somus/pipr/commit/64addf117c9c47c2c853bde63e3502d8254468da))

## [0.1.3](https://github.com/somus/pipr/compare/v0.1.2...v0.1.3) (2026-07-02)


### Bug Fixes

* gate releases on main ci ([#7](https://github.com/somus/pipr/issues/7)) ([eb479e0](https://github.com/somus/pipr/commit/eb479e003990acbad3a30ca4f7c28f171f120a97))

## [0.1.2](https://github.com/somus/pipr/compare/v0.1.1...v0.1.2) (2026-07-02)


### Bug Fixes

* capitalize review header ([d5dfb04](https://github.com/somus/pipr/commit/d5dfb04d983743ef69e82146c777ee21f0f7cb27))

## [0.1.1](https://github.com/somus/pipr/compare/v0.1.0...v0.1.1) (2026-07-02)


### Features

* initial commit ([f5efd56](https://github.com/somus/pipr/commit/f5efd56ae24fbc016eaa0b351032ab1ea172e90e))
