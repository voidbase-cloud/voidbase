# The registry protocol: what a marketplace serves, and what an instance checks

A marketplace is a server that answers three GETs. Ours is one; anyone can run another; an instance connects to
several and is locked to none of them, our official plugins included. The protocol is small on purpose: a static
site with object storage is enough to run a marketplace, and an instance trusts a bundle because of its integrity
hash and the recorded audit, not because of whose host name served it.

`src/node/registry.ts` is the instance's side (types, the validator, integrity, fetch, pick, download), and
`test/fixtures/registry/` is a complete marketplace on disk, served by `Bun.serve` in `test/unit/registry.test.ts`.
Use the fixture as the reference: if your marketplace serves what it serves, an instance can read it.

## The three GETs

| | |
| --- | --- |
| `GET <base>/registry/v1/index.json` | everything the marketplace lists: its name, its plugins with every version each has, and its templates |
| `GET <base>/registry/v1/plugins/<name>/<version>.json` | one version record, the same object the index carries |
| `GET <base>/registry/v1/plugins/<name>/<version>/bundle.js` | the bundle, one ES module (the `bundle` field names it; a relative URL is relative to the index) |

A marketplace is named by its base URL. Everything under `registry/v1/` is public and needs no account; the index
may change, a version record and its bundle never do once published (a change is a new version).

## The index

```json
{
  "schemaVersion": 1,
  "marketplace": { "name": "fixture", "url": "https://marketplace.example" },
  "generatedOn": "2026-09-09",
  "plugins": [{
    "name": "echo",
    "repository": "example/voidbase-plugin-echo",
    "title": "Echo",
    "summary": "Answers /api/echo.",
    "latest": "0.1.0",
    "versions": [{
      "version": "0.1.0",
      "manifest": { "name": "echo", "version": "0.1.0", "tier": "community", "voidbase": "*" },
      "integrity": "sha256-…",
      "bundle": "plugins/echo/0.1.0/bundle.js",
      "bytes": 512,
      "source": { "repository": "example/voidbase-plugin-echo", "commit": "0123456…" },
      "publishedOn": "2026-09-09",
      "audit": { "ranOn": "2026-09-09", "checks": [{ "name": "…", "passed": true, "detail": "…" }] }
    }]
  }],
  "templates": [{ "repository": "example/voidbase-template-blank", "title": "Blank", "summary": "…" }]
}
```

- `name` is the manifest's name (`^[a-z][a-z0-9-]*$`) and a marketplace serves each name once. Two marketplaces
  serving one name is the instance's problem, and it refuses the ambiguity unless the lockfile qualifies the plugin
  as `<marketplace>/<name>`, the same rule the loader applies to two providers of one interface.
- `manifest` is `plugin.json` as the source declares it (`src/server/plugins/manifest.ts`), checked with
  `checkManifest`, and it has to name this plugin and this version. The instance checks the loaded bundle's
  manifest says the same, which is what stops a bundle claiming one thing and being another.
- `integrity` is SRI: `sha256-` and the base64 of SHA-256 over the bundle's bytes. The instance recomputes it on
  every download and every build.
- `source` is where the bytes came from and the commit they were built at, so a later change to the repository is
  visible as a change.
- `audit` is what the marketplace checked, with the reason for every check, so a reader can disagree with any one
  of them. Its absence is allowed and visible.
- `templates` are pointers: a template is started from on GitHub (*Use this template*), so a marketplace only
  lists them.

## The bundle

One ES module. Its default export is the plugin: `{ manifest, apply(ctx) }` as `Plugin` in
`@voidbase-cloud/voidbase/plugins` defines it. It may import from `@voidbase-cloud/voidbase/*` (the entry points an
instance provides) and from `hono`, because the instance has both; everything else it needs is inside the file. It
never imports Node built-ins, because an instance may be a Worker. A bundle is evaluated inside the instance the way
`pb_hooks` is; a marketplace builds and audits it and never runs it.

## What an instance does with it

1. Reads the index and refuses it with every reason named if it is not a registry (`problemsWithIndex`).
2. Picks a version (`latest` unless told otherwise), downloads the bundle, recomputes the integrity, and refuses a
   mismatch.
3. Records, in `voidbase.lock`, the marketplace it came from, the version, the integrity and the source commit.
4. Loads the bundle beside the plugins it ships and resolves the whole graph as it does for them: two providers of
   one interface, a cycle, a missing requirement or a version outside the range are refused before anything runs.

Steps 3 and 4 are the install side of the plan (`plan.md`, Phase 6 and 7) and are not built yet; 1 and 2 are
`src/node/registry.ts` today.

## Running your own

Serve the files. The fixture is the layout: `registry/v1/index.json`, `registry/v1/plugins/<name>/<version>.json`,
`registry/v1/plugins/<name>/<version>/bundle.js`. Generate them however you like; ours are generated by the
marketplace's pipeline from a repository at a commit (audit the source, bundle it, audit the bundle, hash it) and
committed, because a listing that arrives as a commit can be read, reviewed and reverted.
