// `@voidbase-cloud/voidbase/backups-api`: the backups routes, for the plugin that mounts them.
//
// plugins/backups.ts is one call — `mountBackupsApi(ctx.app)` — and this is that call. The archive format, the
// checksums and the off-site copy stay unpublished in ../backups.ts: they are the core's own, read by the cron and
// by `voidbase backup`, and a plugin package has no use for them.
export { mountBackupsApi } from "../backups";
