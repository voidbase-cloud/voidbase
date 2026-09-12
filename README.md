# voidbase — repository

This repository is a Bun workspace. Every package it publishes carries the same version:

| path | what |
| --- | --- |
| [`packages/voidbase`](packages/voidbase) | **`@voidbase-cloud/voidbase`**, the core package, and the Void app this repository runs to test it. Its [README](packages/voidbase/README.md) is the project's. |
| `packages/plugin-*` | one shipped plugin each, extracted into a package of its own: [`realtime`](packages/plugin-realtime) (7.5, the template) and [`domains`](packages/plugin-domains). The core depends on each and loads it, so an instance is unchanged; `@voidbase-cloud/voidbase/plugins/<name>` stays published as a re-export of the package. |
| `scripts/` | this repository's CI and release tooling (`ci.sh`, `release.sh`, `pipeline.ts` and the rest). It is not published: consumers used to download it with every install. |
| `ci/` | the status Worker a build deploys ([docs/ci.md](packages/voidbase/docs/ci.md)). |
| `surface/` | the surface map, rendered by `bun run surface`. |

```bash
bun install          # also installs the git hooks
bun run check        # codegen and every typecheck pass: the package's two configs and the root's scripts config
bun test             # the unit tests
bun run dev          # the app in packages/voidbase
bun run ci           # the whole CI flow, the way Cloudflare runs it
```

`bunfig.toml` pins `linker = "hoisted"`. The CI and release scripts call binaries out of the root's
`node_modules/.bin` by path (`wrangler`, `void`, `vp`, `commitlint`, `tsc`), and several of those come from `void`
and `vite-plus` transitively; the isolated linker, which Bun switches to on its own once `package.json` names
`workspaces`, leaves the root with only its own declared devDependencies and none of those binaries.

[CONTRIBUTING.md](CONTRIBUTING.md) · [LICENSE](packages/voidbase/LICENSE)
