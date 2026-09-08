# Changelog

Entries after 0.1.0 are compiled by release-please from the Conventional Commits merged since the previous release
(docs/releasing.md); 0.1.0 was written by hand.

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
