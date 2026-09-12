// Seeds a local Void state directory's D1 file with the system tables from db/migrations/*.sql, for dev/preview
// servers that use `voidPlugin({ persistTo })` (void db migrate only knows the default .void state).
//   bun scripts/seed-d1.ts <persistDir>   e.g. .void-ci
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
const target = process.argv[2]; if (!target) { console.error("usage: bun scripts/seed-d1.ts <persistDir>"); process.exit(1); }
// miniflare names the database file deterministically from the binding; reuse the default state's name when present
const defaultDir = ".void/v3/d1/miniflare-D1DatabaseObject";
const fileName = (existsSync(defaultDir) ? readdirSync(defaultDir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite") : undefined) ?? "6a4e4d6dbf1fb3c3d2b0b0b6b2a2d4e7c1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6.sqlite";
const dir = `${target}/v3/d1/miniflare-D1DatabaseObject`; mkdirSync(dir, { recursive: true });
const db = new Database(`${dir}/${fileName}`, { create: true });
let applied = 0;
for (const f of readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort()) {
  for (const statement of readFileSync(`db/migrations/${f}`, "utf8").split("--> statement-breakpoint")) if (statement.trim()) { try { db.run(statement); applied++; } catch (e) { if (!String(e).includes("already exists")) throw e; } }
}
db.close();
console.log(`seeded ${dir}/${fileName} with ${applied} statements`);
