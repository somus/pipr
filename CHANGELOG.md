# Changelog

This changelog is generated from Conventional Commits by Release Please.
Published releases and downloadable CLI artifacts are available on
[GitHub Releases](https://github.com/somus/pipr/releases).

## [0.5.1](https://github.com/somus/pipr/compare/v0.5.0...v0.5.1) (2026-07-24)


### Features

* **review:** add deep review recipe ([#116](https://github.com/somus/pipr/issues/116)) ([380f98d](https://github.com/somus/pipr/commit/380f98d8c7802186892bbe5642e1359b887bd646))
* **runtime:** add shared structural analysis ([#117](https://github.com/somus/pipr/issues/117)) ([fe063b0](https://github.com/somus/pipr/commit/fe063b04aefe09762367aaafc2f3a76c0cc77393))
* **runtime:** add structural manifest context ([#119](https://github.com/somus/pipr/issues/119)) ([5eb7746](https://github.com/somus/pipr/commit/5eb7746ca78e02fd436b14fc15b3e19636729d33))
* **runtime:** add structural review tools ([#118](https://github.com/somus/pipr/issues/118)) ([676bc42](https://github.com/somus/pipr/commit/676bc426d7d1064c8ece1394a7b47cee72b261c9))


### Bug Fixes

* **release:** fetch history for audit ([4d208be](https://github.com/somus/pipr/commit/4d208be18be1cceac2fd066bd86ff68fae0fced6))
* review defects in moved code ([#114](https://github.com/somus/pipr/issues/114)) ([e138c45](https://github.com/somus/pipr/commit/e138c450c8bf92459a7984c5c354d6e9a05d395f))

## [0.5.0](https://github.com/somus/pipr/compare/v0.4.3...v0.5.0) (2026-07-20)


### Features

* **cli:** version local review JSON output ([#101](https://github.com/somus/pipr/issues/101)) ([312b31e](https://github.com/somus/pipr/commit/312b31e54f325befa3b67da7a1e4941d8c101508))
* **config:** add explicit memory curation ([#102](https://github.com/somus/pipr/issues/102)) ([30f8b01](https://github.com/somus/pipr/commit/30f8b01cbb8d5f7457eb11f8fdbf5d2aeacbb895))
* **runtime:** add run results and webhook history ([#106](https://github.com/somus/pipr/issues/106)) ([1aaed2b](https://github.com/somus/pipr/commit/1aaed2ba238df9bdf4fc133b204ac260eaa2a8ed))
* **sdk:** expose review run context ([#107](https://github.com/somus/pipr/issues/107)) ([9bc33ed](https://github.com/somus/pipr/commit/9bc33ed6b338575a242f073995bcf9d12b9836de))
* stabilize review outputs and release packages ([#104](https://github.com/somus/pipr/issues/104)) ([a25b6bc](https://github.com/somus/pipr/commit/a25b6bc0e85199d6381b43a31eb8c1943a50e7f9))


### Bug Fixes

* **runtime:** bound diff manifest construction ([#99](https://github.com/somus/pipr/issues/99)) ([9bb367a](https://github.com/somus/pipr/commit/9bb367a5d2cd9392e5e5e7fc858eb2ade9e20edd))
* **sdk:** harden public runtime boundaries ([#103](https://github.com/somus/pipr/issues/103)) ([d1f45c6](https://github.com/somus/pipr/commit/d1f45c638f24f8fe3e69934b7c10d916cc2ab83d))


### Miscellaneous Chores

* release 0.5.0 ([4656539](https://github.com/somus/pipr/commit/4656539e7260294675f2a3ad9688403519f6c07a))

## [0.4.3](https://github.com/somus/pipr/compare/v0.4.2...v0.4.3) (2026-07-18)


### Bug Fixes

* **config:** collapse dogfood inline rationales ([#93](https://github.com/somus/pipr/issues/93)) ([9b646b5](https://github.com/somus/pipr/commit/9b646b55d8da223e9f5bb7709d82296adacf6a5d))
* **runtime:** pre-exclude discarded diff content ([#95](https://github.com/somus/pipr/issues/95)) ([8847418](https://github.com/somus/pipr/commit/8847418249b59841d42227eaf4d513828a834de0))

## [0.4.2](https://github.com/somus/pipr/compare/v0.4.1...v0.4.2) (2026-07-17)


### Bug Fixes

* **runtime:** apply review policy to custom schemas ([#89](https://github.com/somus/pipr/issues/89)) ([bd134bf](https://github.com/somus/pipr/commit/bd134bf5a2d6ac7eba6e8e74823e3145a09fd21a))
* suppress resolved findings across heads ([#88](https://github.com/somus/pipr/issues/88)) ([63cf68f](https://github.com/somus/pipr/commit/63cf68fe8b8cdc3bb353a8eee1b6dbe7d5482eb6))

## [0.4.1](https://github.com/somus/pipr/compare/v0.4.0...v0.4.1) (2026-07-16)


### Features

* **runtime:** bound serialized review findings ([#82](https://github.com/somus/pipr/issues/82)) ([c1dfd01](https://github.com/somus/pipr/commit/c1dfd01d52ccf2365b378d3e874b05d300919fef))
* tighten inline review comments ([#84](https://github.com/somus/pipr/issues/84)) ([f989120](https://github.com/somus/pipr/commit/f98912050950b0e5c78be8d3242beb47f7c65b42))


### Bug Fixes

* enforce frozen config dependency installs ([#74](https://github.com/somus/pipr/issues/74)) ([f9725e5](https://github.com/somus/pipr/commit/f9725e5a7fb195c46716ad789d0e2d49f9d54d3b))
* harden Azure and Bitbucket adapters ([#78](https://github.com/somus/pipr/issues/78)) ([9eacbac](https://github.com/somus/pipr/commit/9eacbac10a6007f6c5259e6e841b7988256f86bb))
* harden Pi workspace isolation ([#75](https://github.com/somus/pipr/issues/75)) ([d744e4e](https://github.com/somus/pipr/commit/d744e4eb98a5d1e6bebf8828c20a576cef9ba4e6))
* pin Pi container dependencies ([#86](https://github.com/somus/pipr/issues/86)) ([0604029](https://github.com/somus/pipr/commit/06040296450d07ab83ac75023f035edcdac42eeb))
* **runtime:** parse git paths with nul delimiters ([#81](https://github.com/somus/pipr/issues/81)) ([3162092](https://github.com/somus/pipr/commit/3162092d349d3ea509d0f231561e3b1407f9b0bf))


### Performance Improvements

* **runtime:** reuse Pi workspace across attempts ([3677317](https://github.com/somus/pipr/commit/36773172d9c744fa26ed992123b24f64ed92fa41))

## [0.4.0](https://github.com/somus/pipr/compare/v0.3.8...v0.4.0) (2026-07-13)


### Features

* add Azure DevOps adapter ([#64](https://github.com/somus/pipr/issues/64)) ([38213f9](https://github.com/somus/pipr/commit/38213f9a4e3ce7c463c2d9737fed87b1979c6139))
* add Bitbucket Cloud adapter ([#65](https://github.com/somus/pipr/issues/65)) ([9b5c336](https://github.com/somus/pipr/commit/9b5c336bcb8a4561656b9a5a39d9c5e9ab2f6f26))
* add code host adapter foundation ([#62](https://github.com/somus/pipr/issues/62)) ([f6018df](https://github.com/somus/pipr/commit/f6018dfe6046ef8aefbb02ae08f91e247da22962))
* add Docker webhook deployment ([#69](https://github.com/somus/pipr/issues/69)) ([27ccd5b](https://github.com/somus/pipr/commit/27ccd5bf2a13c60b612e5b247213a0f57afdce07))
* add GitLab adapter ([#63](https://github.com/somus/pipr/issues/63)) ([d6c639a](https://github.com/somus/pipr/commit/d6c639a4c73e6a1fe91c6aea8d67c7bda1c67334))


### Bug Fixes

* bound Pi streaming memory ([#68](https://github.com/somus/pipr/issues/68)) ([0313af5](https://github.com/somus/pipr/commit/0313af53b78926cc1c0875c0bb482041c3ef3eec))
* track GitLab image assertion version ([#71](https://github.com/somus/pipr/issues/71)) ([6d9116a](https://github.com/somus/pipr/commit/6d9116a05741f4036563fc1f909b4106edb72c73))


### Miscellaneous Chores

* release 0.4.0 ([c3554e7](https://github.com/somus/pipr/commit/c3554e70cbfc8c77247c8bd16271887a2d636a2d))

## [0.3.8](https://github.com/somus/pipr/compare/v0.3.7...v0.3.8) (2026-07-11)


### Features

* **config:** configure main comment presentation ([#56](https://github.com/somus/pipr/issues/56)) ([3c9de80](https://github.com/somus/pipr/commit/3c9de807d3095cba19ac102bc006703addc0b68e))

## [0.3.7](https://github.com/somus/pipr/compare/v0.3.6...v0.3.7) (2026-07-11)


### Features

* **runtime:** add collapsible review stats ([#53](https://github.com/somus/pipr/issues/53)) ([5bb8fa3](https://github.com/somus/pipr/commit/5bb8fa371f063cf07732abe522ef391accce1dbd))

## [0.3.6](https://github.com/somus/pipr/compare/v0.3.5...v0.3.6) (2026-07-10)


### Features

* harden review prompts and recipes ([#51](https://github.com/somus/pipr/issues/51)) ([59cf563](https://github.com/somus/pipr/commit/59cf563ada6ab0ba32148022c306a40684c068a3))


### Bug Fixes

* gate suggested fixes in prompt evals ([#49](https://github.com/somus/pipr/issues/49)) ([86daeca](https://github.com/somus/pipr/commit/86daeca516be64be99e41fb446927cd7119a3770))

## [0.3.5](https://github.com/somus/pipr/compare/v0.3.4...v0.3.5) (2026-07-09)


### Bug Fixes

* **runtime:** avoid resolving runtime config SDK pins ([#46](https://github.com/somus/pipr/issues/46)) ([7a7899a](https://github.com/somus/pipr/commit/7a7899a57278318ccbd55c8c9b7c534cfc76f1e3))

## [0.3.4](https://github.com/somus/pipr/compare/v0.3.3...v0.3.4) (2026-07-09)


### Features

* **sdk:** expose default review entrypoints ([#44](https://github.com/somus/pipr/issues/44)) ([6c26186](https://github.com/somus/pipr/commit/6c2618624ee244d5b6e12796a2b72d4f58e97a1e))


### Bug Fixes

* handle pipr config version mismatches ([#41](https://github.com/somus/pipr/issues/41)) ([df48d2b](https://github.com/somus/pipr/commit/df48d2b343f2a6dc2291873a64e61942558ad1f2))
* improve Pipr agent setup flow ([7f1daed](https://github.com/somus/pipr/commit/7f1daedcb220580d1b170f3abcdcb97112d8c765))
* **runtime:** align review summaries and action e2e scope ([#42](https://github.com/somus/pipr/issues/42)) ([e7fa703](https://github.com/somus/pipr/commit/e7fa703e0be54ef7189c727df4d92241718d09e9))

## [0.3.3](https://github.com/somus/pipr/compare/v0.3.2...v0.3.3) (2026-07-08)


### Features

* **recipes:** improve review summary presentation ([#40](https://github.com/somus/pipr/issues/40)) ([3a73760](https://github.com/somus/pipr/commit/3a737604cd05cd93d5cb0aeeea0b5891a0b32c3a))


### Bug Fixes

* skip release-created pipr comments ([#38](https://github.com/somus/pipr/issues/38)) ([0c62cde](https://github.com/somus/pipr/commit/0c62cde0302084a022bb421e77b1ea9055e24e17))

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
