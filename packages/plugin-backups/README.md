# @voidbase-cloud/plugin-backups

The backups plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It mounts the
archive routes: two kinds (`full`, the whole instance with its settings and schema; `data`, the non-system
collections' rows and files), each read back and verified after the write, restorable per kind, copied off-site when
`VOIDBASE_BACKUP_S3_*` are set, and written on a schedule shaped by `VOIDBASE_BACKUP_KIND` and `VOIDBASE_BACKUP_KEEP`.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

Twelve lines and one call. The archives themselves are the core's: writing one reads the whole instance's settings,
schema, rows and files, the scheduled write runs in the Worker's cron and the restore writes back through the
collections service, so what moved out is the plugin — the manifest and the `apply()` that mounts the routes —
and not the feature.

- **It imports the core by name and only by name**: `@voidbase-cloud/voidbase/backups-api` (`mountBackupsApi`, the
  narrow entry published for this plugin), `/kernel` and `/plugins`.
- **`/backups-api` publishes the call, not the module behind it.** The backups module also writes, verifies, prunes
  and restores archives, and the scheduled job and the CLI reach those the core's own way; the entry hands a plugin
  the one function it mounts.
- **`@voidbase-cloud/voidbase/plugins/backups` stays published forever**, as a re-export of this package.

The rest of the shape — the lockstep version, the peer edge back on the core, `hono` declared at the core's own
range, npm as the only registry this name is published to — is the template `packages/plugin-realtime/README.md`
describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every
`@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
