# Changelog

This changelog is generated from Conventional Commits by Release Please.
Published releases and downloadable CLI artifacts are available on
[GitHub Releases](https://github.com/somus/pipr/releases).

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
