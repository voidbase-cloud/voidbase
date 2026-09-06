/// <reference path="../../../pb_data/types.d.ts" />
// the project's own PocketBase migration, copied in beside the ones generated from db/migrations
migrate(async (app) => {
  await app.execSQL("CREATE TABLE IF NOT EXISTS `marker` (`id` text PRIMARY KEY NOT NULL)");
}, async (_app) => {});
