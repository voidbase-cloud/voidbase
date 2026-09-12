# @voidbase-cloud/plugin-previews

The previews plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It is what
an instance knows about being a preview: which of the two shapes it is in, which branches have rows on it, and the
route that takes a branch's rows away again.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

A preview comes in two shapes, and only one of them makes an instance.

- **`--shape instance`** is a Worker of its own, with its own database, bucket and queue, deployed for one branch
  and seeded from production. Everything about making one happens around a deploy, in the plugin's deploy-time
  half — which is *not* in this package: a deploy plugin runs inside `voidbase deploy`, in the CLI's process,
  against the Cloudflare and GitHub APIs, so `src/node/plugins/previews.ts` stays in the core and reads the two var
  names and the naming rule back through `@voidbase-cloud/voidbase/plugins/previews`, the entry the core keeps.
- **`--shape flagged`** makes no instance at all: the branch shares production and its writes carry a mark that
  production's reads filter out. The mark and the filter are in the core's records path, because every read has to
  agree about them; `/records-preview` publishes the four names a plugin needs of it, and `/records-files` the one
  call that empties a deleted row's files.

The first extracted plugin with routes of its own — `GET /api/previews` and `DELETE /api/previews`, both superuser
— so it is also the first that imports `hono`, which is a peerDependency at the core's own range because a plugin's
routes go on the core's own Hono app.

The rest of the shape — the lockstep version, the peer edge back on the core, npm as the only registry this name is
published to — is the template `packages/plugin-realtime/README.md` describes, and
`packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every `@voidbase-cloud/plugin-*` package in
the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
