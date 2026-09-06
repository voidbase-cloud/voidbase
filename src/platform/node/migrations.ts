import { resolve } from "node:path";
import { compileMigrationsDir } from "../../../hooks-plugin";
import { loadCompiled } from "./hooks";
const mod = await loadCompiled(compileMigrationsDir(resolve(process.env.VOIDBASE_MIGRATIONS_DIR ?? "pb_migrations")), "migrations");
export const migrations: { name: string; run: (globals: Record<string, unknown>) => Promise<void> }[] = mod.migrations;
