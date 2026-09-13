// pb_migrations on Bun, as automigrate writes into it (src/server/automigrate.ts): the folder `voidbase serve` compiles
// migrations from (VOIDBASE_MIGRATIONS_DIR). A binary squashed from an extended project carries its migrations, which
// are the project's, so it has none to write.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { MigrationFiles } from "../server/automigrate";

export const migrationFiles: MigrationFiles | null = process.env.VOIDBASE_PROJECT_BAKED ? null : {
  write(file, source) {
    const dir = resolve(process.env.VOIDBASE_MIGRATIONS_DIR ?? "pb_migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, basename(file)), source);
  },
};
