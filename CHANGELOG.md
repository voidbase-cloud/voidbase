# Changelog

Entries after 0.1.0 are compiled by release-please from the Conventional Commits merged since the previous release
(docs/releasing.md); 0.1.0 was written by hand.

## [0.9.0-beta.26](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.25...v0.9.0-beta.26) (2026-09-11)

* feat(serve): run the instance on Cloudflare's local runtime with --workers

## [0.9.0-beta.25](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.24...v0.9.0-beta.25) (2026-09-11)

* chore(ci): start the first hot release

## [0.9.0-beta.24](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.23...v0.9.0-beta.24) (2026-09-10)


### Features

* **plugin:** the installer: an instance changes its own plugins ([d3fd67a](https://github.com/voidbase-cloud/voidbase/commit/d3fd67a2abf9cd68da92b6481ab87b72b4b2e485))

## [0.9.0-beta.23](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.22...v0.9.0-beta.23) (2026-09-10)


### Bug Fixes

* **deploy:** a Workflow step evaluates the app module before it opens the app ([b06d31c](https://github.com/voidbase-cloud/voidbase/commit/b06d31c51aaef702b86db800111ac35eaa2c4278))

## [0.9.0-beta.22](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.21...v0.9.0-beta.22) (2026-09-10)


### Bug Fixes

* **deploy:** the vars file is written after the store block ([38ccb84](https://github.com/voidbase-cloud/voidbase/commit/38ccb842ad9e144770a4f6bd1e62b3050b7844a8))

## [0.9.0-beta.21](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.20...v0.9.0-beta.21) (2026-09-10)


### Bug Fixes

* **ci:** fresh-db brings the boot step with it in hot mode ([acb61ab](https://github.com/voidbase-cloud/voidbase/commit/acb61abb251a08ab11291ae0d2ca7edcd795a267))
* **deploy:** a Workflow step reaches the app and its store secrets ([3b8f93e](https://github.com/voidbase-cloud/voidbase/commit/3b8f93e786a9c6c516a97af031e8615dd6f66f29))

## [0.9.0-beta.20](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.19...v0.9.0-beta.20) (2026-09-10)


### Features

* **ci:** the instance builder is voidbase-ci's second trigger; no branches trigger ([8ca3e4a](https://github.com/voidbase-cloud/voidbase/commit/8ca3e4ad806990bf04f651535a67bb4b9d65115b))


### Bug Fixes

* **deploy:** a Flagship flag is created with its (empty) rules array ([5ba55d6](https://github.com/voidbase-cloud/voidbase/commit/5ba55d6f51db11210c02336ee12d03873375cf6c))
* **deploy:** voidbase sync connects one trigger, and removes the branches trigger it used to make ([a9676af](https://github.com/voidbase-cloud/voidbase/commit/a9676afc459a9531531f62d15759f74fbed043ed))


### Documentation

* **plan:** the project side of the cloud exists; the demo is a system project ([c06ff52](https://github.com/voidbase-cloud/voidbase/commit/c06ff520e6f278817ab00452935bfc41dbf35658))
* **plugins:** project instances: plugins as commits to the linked repository ([0cfa4ad](https://github.com/voidbase-cloud/voidbase/commit/0cfa4ad2a2db0169e5d5456e6d5702ac720166de))

## [0.9.0-beta.19](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.18...v0.9.0-beta.19) (2026-09-09)


### Features

* **adapter:** workflows/ modules become Cloudflare Workflows, exported from the Worker and bound ([0031925](https://github.com/voidbase-cloud/voidbase/commit/0031925475b5a5c892dafb07ee891ac9a5ba39d1))

## [0.9.0-beta.18](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.17...v0.9.0-beta.18) (2026-09-09)


### Features

* **deploy:** a flag() tier, held by Cloudflare Flagship and evaluated per request ([2050f97](https://github.com/voidbase-cloud/voidbase/commit/2050f97e99593949e27234d20cba149b50068a75))

## [0.9.0-beta.17](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.16...v0.9.0-beta.17) (2026-09-09)


### Features

* **deploy:** the account's Secrets Store holds a Worker's declared secrets when asked ([0cb82c2](https://github.com/voidbase-cloud/voidbase/commit/0cb82c2a3a6cce4c481e37cc19088272e79b1b05))

## [0.9.0-beta.16](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.15...v0.9.0-beta.16) (2026-09-09)


### Bug Fixes

* **bundle:** a bundle's voidbase and hono imports resolve when built from voidbase's checkout ([ed25297](https://github.com/voidbase-cloud/voidbase/commit/ed25297ac7ed99eba12a656cce89eaaaa3fd1bda))


### Documentation

* **plan:** what the cloud loop found about bundles built from voidbase's own checkout ([4613a9b](https://github.com/voidbase-cloud/voidbase/commit/4613a9b836f6f9030820a34f4e283d2f97012c5b))

## [0.9.0-beta.15](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.14...v0.9.0-beta.15) (2026-09-09)


### Features

* **plugin:** a plugin creates the collections it owns, once, at bootstrap ([b645279](https://github.com/voidbase-cloud/voidbase/commit/b64527997f55d682e49d5fdeee8de4ad041740da))


### Documentation

* **plan:** auth as the core plugin, proven on the testbeds, packaged and listed ([d62af16](https://github.com/voidbase-cloud/voidbase/commit/d62af167cb2ec8160c101e85dced53479befd858))

## [0.9.0-beta.14](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.13...v0.9.0-beta.14) (2026-09-09)


### Features

* **auth:** auth is the core plugin providing auth@1, and the core asks it through a slot ([c3e8282](https://github.com/voidbase-cloud/voidbase/commit/c3e8282df30029b36ea60e3fe19bee4f9740ece8))


### Bug Fixes

* **ci:** a merged release whose own build failed is published by the next build of master ([0b4e904](https://github.com/voidbase-cloud/voidbase/commit/0b4e9044de46bae59fd8a0fc0a87d4683335fe0e))
* **release:** the testbeds step waits for the manifest bun reads and retries the install ([d90b5a1](https://github.com/voidbase-cloud/voidbase/commit/d90b5a123e484ff80ebf08524e46b2abb090b478))


### Documentation

* **plan:** the apps' pipelines cut to build and sync, and the three-ways direction ([bd7f3de](https://github.com/voidbase-cloud/voidbase/commit/bd7f3de0fef4c53f4f6d2db332f695976585cb02))

## [0.9.0-beta.13](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.12...v0.9.0-beta.13) (2026-09-09)


### Bug Fixes

* **adapter:** an app's crons become the Worker's cron triggers ([cc299a5](https://github.com/voidbase-cloud/voidbase/commit/cc299a5d3caa65040dad98fa99dfc22a7482b4be))
* **release:** the testbeds step pushes with its own token, not the build image's identity ([1c63aa5](https://github.com/voidbase-cloud/voidbase/commit/1c63aa58c3b61afc1b684386833b83c8424ddd5b))
* **release:** the testbeds step waits for npm to serve the version before moving them ([ce219c4](https://github.com/voidbase-cloud/voidbase/commit/ce219c43618f1e0cf8e637208b8b7280c891c89d))

## [0.9.0-beta.12](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.11...v0.9.0-beta.12) (2026-09-09)


### Features

* **cloud:** the instance builder is a Cloudflare build the control plane starts ([c7a70d6](https://github.com/voidbase-cloud/voidbase/commit/c7a70d63c2261452f45c58510f180421abc52842))


### Documentation

* **plan:** beta.10 and beta.11 rolled onto the testbeds, and what rolling them found ([fb6e515](https://github.com/voidbase-cloud/voidbase/commit/fb6e5152d016ecb88025576110d2f4b4f3bde024))

## [0.9.0-beta.11](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.10...v0.9.0-beta.11) (2026-09-09)


### Bug Fixes

* **deploy:** a secret declared optional does not block a deploy when it has no value ([0b4c62d](https://github.com/voidbase-cloud/voidbase/commit/0b4c62dbe651aeca01ac6aa4caafe707f6bd6bc6))

## [0.9.0-beta.10](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.9...v0.9.0-beta.10) (2026-09-09)


### Bug Fixes

* **deploy:** store a redeploy's secrets through the Workers API, not through wrangler's stdin ([40b11d6](https://github.com/voidbase-cloud/voidbase/commit/40b11d6a6810ad4a33982697c86a0bb20f87c6dd))


### Documentation

* **plugin:** the cloud install is proven on voidbase.cloud, and the bug the mock hid is recorded ([5ebb52c](https://github.com/voidbase-cloud/voidbase/commit/5ebb52cf53fe741eb9de4f5bba5b155862e9df30))
* **plugin:** the testbeds run themselves: nightly live tests, hourly release tracking ([3a3efaa](https://github.com/voidbase-cloud/voidbase/commit/3a3efaaf7f20d02c7f9322b520e1602a7c7e1658))

## [0.9.0-beta.9](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.8...v0.9.0-beta.9) (2026-09-09)


### Bug Fixes

* **cloud:** the builder prepares its base checkout before building ([440431b](https://github.com/voidbase-cloud/voidbase/commit/440431b3dc7bf322eddb8ff9b3bbd2dd8e409b49))
* **cloud:** the Worker upload sends its Durable Object migration as one object ([5eeb15f](https://github.com/voidbase-cloud/voidbase/commit/5eeb15f4de17aa833c103a7f71e234f085e598a4))


### Documentation

* **plugin:** every shape installs now; the plan records the cloud build path ([29d36a0](https://github.com/voidbase-cloud/voidbase/commit/29d36a00421c400e6de0a2a08ed1c3836d30167c))

## [0.9.0-beta.8](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.7...v0.9.0-beta.8) (2026-09-09)


### Features

* **adapter:** a stack app's installed plugins ride into the generated app ([cf79d6a](https://github.com/voidbase-cloud/voidbase/commit/cf79d6afc5b90a8b2238e46f6a9566d9a3a340ab))
* **cloud:** a release can carry a project's plugins, and a builder makes them for cloud instances ([a0801ea](https://github.com/voidbase-cloud/voidbase/commit/a0801ea2272fb4c0cf4dc31ee1678e626540144c))


### Documentation

* **plugin:** the loop is closed: installed from two marketplaces, live on the demo ([ebbbf02](https://github.com/voidbase-cloud/voidbase/commit/ebbbf0241cf3fc71ff84b4a70fad5ec788e8ddc7))

## [0.9.0-beta.7](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.6...v0.9.0-beta.7) (2026-09-09)


### Features

* **plugin:** install plugins from any marketplace, verified, beside the ones that ship ([e11b918](https://github.com/voidbase-cloud/voidbase/commit/e11b91832f33aaca45535f30e92708dade94746b))


### Documentation

* **plugin:** the marketplace pipeline is built and serving, and the plan says how it differs ([e7e9e87](https://github.com/voidbase-cloud/voidbase/commit/e7e9e8741fdb301e0636b6f2bcf2a5376fa902ca))

## [0.9.0-beta.6](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.5...v0.9.0-beta.6) (2026-09-09)


### Features

* **plugin:** the registry protocol an instance reads a marketplace with ([84d2f1f](https://github.com/voidbase-cloud/voidbase/commit/84d2f1f41ce457a759289a5042bdc11a8cef7c78))


### Documentation

* **plugin:** installing and the marketplace as one system, per the 2026-09-09 direction ([662126e](https://github.com/voidbase-cloud/voidbase/commit/662126e7e148ce9aab49ada4e55e870a4443d119))

## [0.9.0-beta.5](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.4...v0.9.0-beta.5) (2026-09-09)


### Features

* **plugin:** public entry points for plugin packages ([68d7684](https://github.com/voidbase-cloud/voidbase/commit/68d768405da42962b3e8dc3cfbc4017c42823336))

## [0.9.0-beta.4](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.3...v0.9.0-beta.4) (2026-09-08)


### Features

* **plugin:** interfaces, the core tier, and a guard against the core taking them back ([aefa429](https://github.com/voidbase-cloud/voidbase/commit/aefa429a7b1fbafbf20a4bf5b5fafbcf0bd240a9))
* **plugin:** the loader, and the four failures cordis does not catch ([9ee8996](https://github.com/voidbase-cloud/voidbase/commit/9ee89961e48ac0653d99a08ec30087f1944ac59c))
* **plugin:** the request limits as the hardening plugin providing hardening@1 ([f159aca](https://github.com/voidbase-cloud/voidbase/commit/f159aca059cc335bd5a42604b6ddb0a158c54b8f))
* **realtime:** the hub as a request-carried client provided as realtime@1 ([e3dfcfa](https://github.com/voidbase-cloud/voidbase/commit/e3dfcfaf8c2a358358e68b17b6319dc28ee553aa))


### Bug Fixes

* **plugin:** stop warning every instance that it has no auth ([ca09e2e](https://github.com/voidbase-cloud/voidbase/commit/ca09e2e2cb666ad197f388f95e8eff163d330eb1))


### Documentation

* **plugin:** the plan says what was built, and the disposal claim is a test ([9ed66e8](https://github.com/voidbase-cloud/voidbase/commit/9ed66e810ed8db8f77e8f10a7cb51ffbedc62538))


### Refactoring

* **plugin:** drop the binding phase, and record what building it changed ([83e9c6e](https://github.com/voidbase-cloud/voidbase/commit/83e9c6e4b7c58d409891cca8918811471392befb))

## [0.9.0-beta.3](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.2...v0.9.0-beta.3) (2026-09-08)


### Bug Fixes

* **crons:** maintenance stopped riding the realtime stream, where it was being cancelled ([ab90dce](https://github.com/voidbase-cloud/voidbase/commit/ab90dceb052c7dabfc2bfd908c61d505c944f4c2))

## [0.9.0-beta.2](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta.1...v0.9.0-beta.2) (2026-09-08)


### Features

* **cli:** voidbase init --template starts from somebody's published project ([5a5ce94](https://github.com/voidbase-cloud/voidbase/commit/5a5ce941141edc8cce765f697454238470dc3308))
* **cloud:** provisioning can upgrade an instance that already exists ([62c4002](https://github.com/voidbase-cloud/voidbase/commit/62c4002881b46fdbecdf2acbfead68eee9b32286))
* **deploy:** keep Workers invocation logs, so an instance can be looked at ([883866f](https://github.com/voidbase-cloud/voidbase/commit/883866f30aa3f77de34deb0fa111967392893669))


### Bug Fixes

* **cli:** compare prerelease tags by semver's rules, not as text ([b51a0ea](https://github.com/voidbase-cloud/voidbase/commit/b51a0ea293ad1553c1df842ecd04f897b670c98a))
* **cloud:** find instances by what they are made of, not by a tag deploy cannot set ([1c2a8c0](https://github.com/voidbase-cloud/voidbase/commit/1c2a8c034e849248c415eca7ac878a0dc099a460))
* **test:** the release archive name carries a prerelease version now ([59ed05b](https://github.com/voidbase-cloud/voidbase/commit/59ed05b29cfdf4d4e3fc5b013d9ebf72482cf0a1))


### Refactoring

* **ci:** simplify build supervision logic in deployment notes ([70a6624](https://github.com/voidbase-cloud/voidbase/commit/70a66245b6cd96fdaf9110cc597c4be3c0219e9f))

## [0.9.0-beta.1](https://github.com/voidbase-cloud/voidbase/compare/v0.9.0-beta...v0.9.0-beta.1) (2026-09-08)


### Bug Fixes

* **release:** publish a prerelease with an explicit tag, which npm requires ([e1e0260](https://github.com/voidbase-cloud/voidbase/commit/e1e026029a855e2e992f783a6393dcee1269a9e9))

## [0.9.0-beta](https://github.com/voidbase-cloud/voidbase/compare/v0.8.0...v0.9.0-beta) (2026-09-08)


### Features

* **cli:** voidbase update works whichever way voidbase is installed ([a832922](https://github.com/voidbase-cloud/voidbase/commit/a832922c5ca47f2b745251d893733d9ef3bd5849))


### Bug Fixes

* **cli:** let the executable answer for itself when it is already current ([150fa49](https://github.com/voidbase-cloud/voidbase/commit/150fa4942df55c3d5757e90bd688e95d05696d01))
* **cli:** offer a prerelease, which is what GitHub's latest release deliberately hides ([72e5f7d](https://github.com/voidbase-cloud/voidbase/commit/72e5f7d482c304c5f39e6979124af4ed7e2de7d3))

## [0.8.0](https://github.com/voidbase-cloud/voidbase/compare/v0.7.0...v0.8.0) (2026-09-08)


### Features

* **cli:** list and delete instances without a project ([2ee40bb](https://github.com/voidbase-cloud/voidbase/commit/2ee40bb0d45b97df5b967833f5beeb8a12f2c1c6))
* **cli:** named instances on this machine, not only on Cloudflare ([f0d3f6f](https://github.com/voidbase-cloud/voidbase/commit/f0d3f6fa5023ccdd7772b3ce2a48236033b2a96e))


### Bug Fixes

* **cli:** a scaffolded project can deploy itself from a build machine ([c1cf2df](https://github.com/voidbase-cloud/voidbase/commit/c1cf2df018e531e24f1a94b406a9386fa2d56d96))


### Documentation

* **ci:** record which build events are declined and why ([a8aa34f](https://github.com/voidbase-cloud/voidbase/commit/a8aa34f96ac71e566284519bef58633793761da5))
* setup guides, from an empty machine to a running instance ([4268c00](https://github.com/voidbase-cloud/voidbase/commit/4268c00a96a7243a48514156cecd5b95abac28b6))

## [0.7.0](https://github.com/voidbase-cloud/voidbase/compare/v0.6.2...v0.7.0) (2026-09-07)


### Features

* **ci:** three verbs that read the environment, not the dashboard ([bd01033](https://github.com/voidbase-cloud/voidbase/commit/bd01033d3dea9ba6c0ae792a7def93f39d023890))
* **cli:** voidbase sync writes the three verbs into the triggers it creates ([4d3815a](https://github.com/voidbase-cloud/voidbase/commit/4d3815a8e843ba10cec31178697ccff99921d3d9))


### Bug Fixes

* **ci:** a build started inside the CI suite is the app build, not the suite again ([50e1b4c](https://github.com/voidbase-cloud/voidbase/commit/50e1b4c44c96ce54a168d45e7f2e13c22cf9d060))
* **test:** the OTP suite waits for the user's own mail, not whatever lands first ([0ddada3](https://github.com/voidbase-cloud/voidbase/commit/0ddada314d620c75c11f2ad7c6dc5bc686056a53))


### Documentation

* **ci:** record the three environment-reading verbs in the surface map ([57d7d1e](https://github.com/voidbase-cloud/voidbase/commit/57d7d1e4d34b93f040fa45af73324106a2b68761))
* **deploy:** say what `bun run build` means in a Cloudflare build ([f61870e](https://github.com/voidbase-cloud/voidbase/commit/f61870eb0acaeec6e6ab6952ec0bd01b2e55311d))

## [0.6.2](https://github.com/voidbase-cloud/voidbase/compare/v0.6.1...v0.6.2) (2026-09-07)


### Bug Fixes

* **adapter:** the build never waits on a child it did not need ([904ce3b](https://github.com/voidbase-cloud/voidbase/commit/904ce3bc385b5614dce49986ba3d538392fc7afc))
* **deps:** do not publish voidbase's own tsconfig ([8d6aec5](https://github.com/voidbase-cloud/voidbase/commit/8d6aec59e11c67d46611732f6f36f90adb4bd4c0))


### Documentation

* **surface:** presence ([d8d9ff4](https://github.com/voidbase-cloud/voidbase/commit/d8d9ff40589aff45938b4e632c640af4a99ea601))

## [0.6.1](https://github.com/voidbase-cloud/voidbase/compare/v0.6.0...v0.6.1) (2026-09-07)


### Bug Fixes

* **deploy:** a project is not deployed onto another project's Worker ([03aa8ac](https://github.com/voidbase-cloud/voidbase/commit/03aa8ac18f849220774d1aa56e1063ffeb5bd353))

## [0.6.0](https://github.com/voidbase-cloud/voidbase/compare/v0.5.1...v0.6.0) (2026-09-07)


### Features

* **hooks:** $app.importCollections, $app.truncateCollection and record.setPassword ([f0c41da](https://github.com/voidbase-cloud/voidbase/commit/f0c41dad9d4cf7d7eea1b90639720e82a379f9d6))


### Bug Fixes

* **deploy:** sync's CI default is a default, and the tests pin CI ([294ffba](https://github.com/voidbase-cloud/voidbase/commit/294ffbae80c00e9a31fd3aaa7d41a8615bebb61a))

## [0.5.1](https://github.com/voidbase-cloud/voidbase/compare/v0.5.0...v0.5.1) (2026-09-07)


### Bug Fixes

* **adapter:** the void prepare spawn gets no stdin and a two-minute deadline ([a5f5797](https://github.com/voidbase-cloud/voidbase/commit/a5f5797e44b4d4d5fda6011661308cdb05c5cd75))
* **deploy:** an installed package deploys from the consumer's tree with a self-contained env.ts ([eae7e94](https://github.com/voidbase-cloud/voidbase/commit/eae7e94b8c8b58e5db0fa8b1a2ec537da0db4fab))
* **deploy:** an installed package deploys: Node loads its TypeScript, the hub is imported by name ([c00ec5b](https://github.com/voidbase-cloud/voidbase/commit/c00ec5b9ebd66a70680191f7766f407e212363b0))

## [0.5.0](https://github.com/voidbase-cloud/voidbase/compare/v0.4.1...v0.5.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* **deploy:** defineSecrets({ KEY: string() }) is an error; write server(string()).

### Features

* **deploy:** a local tier for the tooling's own values ([41ea2a3](https://github.com/voidbase-cloud/voidbase/commit/41ea2a3fe25533cfb8e079b664c6aca0373f6a7d))
* **deploy:** every configuration key states who may read it ([8cb8092](https://github.com/voidbase-cloud/voidbase/commit/8cb809200cdb905371db81cda6ee713215241682))

## [0.4.1](https://github.com/voidbase-cloud/voidbase/compare/v0.4.0...v0.4.1) (2026-09-07)


### Bug Fixes

* **adapter:** a fresh checkout builds ([ace9519](https://github.com/voidbase-cloud/voidbase/commit/ace9519dd2cfed0d01aed0ea9732bd9e283efb76))

## [0.4.0](https://github.com/voidbase-cloud/voidbase/compare/v0.3.0...v0.4.0) (2026-09-07)


### Features

* **deploy:** one configuration declaration with Void's validators, tiered secret / server / public ([e5ee202](https://github.com/voidbase-cloud/voidbase/commit/e5ee20261520fbfba8e90d80ff4f7aa07bf6bc78))

## [0.3.0](https://github.com/voidbase-cloud/voidbase/compare/v0.2.2...v0.3.0) (2026-09-07)


### Features

* **adapter:** build a Void app into a voidbase app ([e1e221b](https://github.com/voidbase-cloud/voidbase/commit/e1e221b1df4b70b6b513a4ce5c665ed73a40efe8))
* **adapter:** compile routes, middleware, crons and queues into pb_hooks ([3837897](https://github.com/voidbase-cloud/voidbase/commit/383789715e53a3467a0f7203df06bcd5b31fa491))
* **adapter:** generate a whole voidbase app into .voidbase/ ([d11db67](https://github.com/voidbase-cloud/voidbase/commit/d11db674fea39954ca8afe8844ec2108040bd944))
* **adapter:** PocketBase's API inside a Void route ([d6008cc](https://github.com/voidbase-cloud/voidbase/commit/d6008cc0d34a8a857965725efc83dcc76c4c8862))
* **adapter:** vb_hooks/ and vb_migrations/ as project-root source ([fd861b0](https://github.com/voidbase-cloud/voidbase/commit/fd861b05afcc744481a0453a40a54149d1cd0c7e))
* **adapter:** vb_hooks/ for PocketBase's event hooks, middleware/ through routerUse ([2baad03](https://github.com/voidbase-cloud/voidbase/commit/2baad03f6f03c57cd98d036b3e8ede6b9d5fe2d0))
* **adapter:** vb_secrets/, the secrets a Void app declares ([a1fda2b](https://github.com/voidbase-cloud/voidbase/commit/a1fda2b4e17029b1db4380cfa118545b3e0efca8))
* **deploy:** _redirects in the public dir become Void edge redirects ([8c43427](https://github.com/voidbase-cloud/voidbase/commit/8c434270bcf7e92731d90f1aaaee9c3cea3b89e6))
* **deploy:** _redirects in the public dir become Void edge redirects ([bf873b4](https://github.com/voidbase-cloud/voidbase/commit/bf873b4ef45806646ee4ee8a80ecbbba5e70307c))
* **deploy:** host-scoped _redirects become zone Redirect Rules ([cd1f8f7](https://github.com/voidbase-cloud/voidbase/commit/cd1f8f7e0080e55656a905c2c861eb923f624be7))
* **deploy:** pb_secrets/, the app's secrets declared in git and valued outside it ([da8e4c6](https://github.com/voidbase-cloud/voidbase/commit/da8e4c636ed1b0b67cbfd61b6b6f2030fbdaaa08))
* **deploy:** serve ./pb_public by default and attach several custom domains ([c8d39bd](https://github.com/voidbase-cloud/voidbase/commit/c8d39bd77ee5ef8e9a2a1c40348ea2715c6c4c18))
* **deploy:** VOIDBASE_DEPLOY_ZONE_TOKEN for the zone redirect rules ([6013d48](https://github.com/voidbase-cloud/voidbase/commit/6013d485be4886f25096229d74309993a2260e16))
* **hooks:** routerUse is PocketBase's global middleware, around every request ([12eaa8a](https://github.com/voidbase-cloud/voidbase/commit/12eaa8ab43214d72c225dc25ffb8411b2838978f))
* **serve:** resolve an extensionless path against &lt;path&gt;.html ([5b7bb26](https://github.com/voidbase-cloud/voidbase/commit/5b7bb26b006d0c0cd5573d1cde99cd457175e5b4))


### Bug Fixes

* **adapter:** report once per build, not once per Vite environment ([a593b1b](https://github.com/voidbase-cloud/voidbase/commit/a593b1b55a99be6fe1b7cd8b148b1d6c357f48c0))
* **adapter:** the generated entry finds its own directories ([3ec53cf](https://github.com/voidbase-cloud/voidbase/commit/3ec53cfe7039cd95efece83f2caf535626b56027))
* **auth:** reject non-canonical base64url token segments like PocketBase ([7d00575](https://github.com/voidbase-cloud/voidbase/commit/7d005752598e640663dfa7cfa69321032ceb7fd2))
* **ci:** read every pushed commit on a shallow checkout ([11acdf3](https://github.com/voidbase-cloud/voidbase/commit/11acdf39b040c8b280e4d5e292db4ddb24aa3060))
* **cloud:** detach the queue consumer before destroying an instance ([2eb5797](https://github.com/voidbase-cloud/voidbase/commit/2eb579797351812b8322582f99a9731556947466))
* **deploy:** a deploy never replaces a secret the Worker already has ([63cc651](https://github.com/voidbase-cloud/voidbase/commit/63cc65148b4bf2bc229c1ec4e7a8a5d2c20e4cfd))
* **deploy:** one token; name the zone permission the redirect rules need ([16d0537](https://github.com/voidbase-cloud/voidbase/commit/16d0537589e6ca354b4220f50600d0569c2a12de))
* **deploy:** secrets.json outranks the .env files ([9df1802](https://github.com/voidbase-cloud/voidbase/commit/9df180212dc0027210cb6f589856da972fa3cce9))


### Performance

* **auth:** passkey routes in every app, gated on a passkeys collection, loaded on first use ([77af85e](https://github.com/voidbase-cloud/voidbase/commit/77af85e447fd971be4e06e272799268982f88eca))


### Documentation

* **ci:** the reference is seeded fresh per run and before the Bun pass ([d3f6d0c](https://github.com/voidbase-cloud/voidbase/commit/d3f6d0c29b35e42b2738faf2f258e9177bebe17e))
* **deploy:** the site's control plane moved to voidbase-site/cloud ([66f2e8c](https://github.com/voidbase-cloud/voidbase/commit/66f2e8c41fe4f66123534e338610d0975d2dcb10))
* **surface:** CI live on Cloudflare with incremental runs ([82a5461](https://github.com/voidbase-cloud/voidbase/commit/82a5461b0af283efa34f32c02c0691c12b927bff))
* **surface:** one CI project on Cloudflare, hot mode and incremental runs ([4665543](https://github.com/voidbase-cloud/voidbase/commit/46655431b081677d1e461f78977ceac1886d94fa))
* **surface:** the Void adapter ([0228acb](https://github.com/voidbase-cloud/voidbase/commit/0228acb4d7e8105a864c32a48db80bc0f68b3ff1))

## [0.2.2](https://github.com/voidbase-cloud/voidbase/compare/v0.2.1...v0.2.2) (2026-09-06)


### Bug Fixes

* **migrations:** later pb_migrations see collections created earlier in the same run ([35b0e94](https://github.com/voidbase-cloud/voidbase/commit/35b0e9499c0862de5c5c76d1696c2104cc205b32))


### Documentation

* **surface:** template marketplace in the control plane ([48b09ae](https://github.com/voidbase-cloud/voidbase/commit/48b09ae5d74b760fcdb64c3315b4df7d61e5ab81))

## [0.2.1](https://github.com/voidbase-cloud/voidbase/compare/v0.2.0...v0.2.1) (2026-09-06)


### Bug Fixes

* **oauth2:** Cloudflare sign-in without the openid scope ([16d660d](https://github.com/voidbase-cloud/voidbase/commit/16d660de61728b705e1aa385b71b2fdf9397a216))

## [0.2.0](https://github.com/voidbase-cloud/voidbase/compare/v0.1.0...v0.2.0) (2026-09-06)


### Features

* **cli:** prebuilt executables with voidbase update, PocketBase-style release archives ([48eef41](https://github.com/voidbase-cloud/voidbase/commit/48eef41f080092cd4c3bdb533e58fa83bfec1026))

## 0.1.0

First release candidate: PocketBase 0.40 wire compatibility on Cloudflare Workers (D1, R2, cron) via Void.

- Collections engine with runtime DDL, all 14 field types, views with inferred fields, import/export, API rule validation.
- Records API: filter/sort/expand/fields, files with thumbnails and ranges, batch, cascade delete.
- Auth: password, OAuth2 (32 providers), OTP, MFA, passkeys, verification / password reset / email change flows, impersonation, auth alerts.
- Realtime over SSE with a D1 change feed; JS hooks and migrations (`pb_hooks`, `pb_migrations`) bundled at build time.
- Settings, SMTP over Cloudflare sockets, S3 file and backup storage, logs, crons, backups, SQL console, rate limits, trusted proxy, encryption at rest.
- Unmodified PocketBase admin panel served at `/_/`; unmodified `pocketbase` JS SDK 0.28 supported.
- Published as `@voidbase-cloud/voidbase` from GitHub Actions (npm + GitHub Packages).
- Cloudflare cost shape: assets and deep links served by the asset layer without invoking the Worker (`404.html` shells, deep links carry status 404), request logs written only from warnings up by default (`VOIDBASE_LOG_MIN_LEVEL`), change-feed rows only while a client is subscribed, cron triggers derived from the hooks' `cronAdd` expressions plus lazy maintenance, Smart Placement, lazy Photon. Background jobs (system mail, automatic backups) through a Cloudflare Queue with retries, a rate-limit binding as a per-location ceiling, an opt-in Analytics Engine request log; `voidbase deploy` creates the queue and declares the bindings. Realtime pushes through a per-instance Durable Object hub (hibernating sockets, tens of milliseconds instead of a one-second poll); the D1 poll remains the fallback without the binding.
- Differential conformance suites against a reference PocketBase, SDK coverage matrix, security suite, generated filter corpus, browser suites for the panel and the SvelteKit starter, CI workflow.
