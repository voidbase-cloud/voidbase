import { env as voidEnv } from "#platform/env";
import { invalidateCollections, type Collection } from "./collections/model";
import { systemCollections } from "./collections/system";
import { all, ident, one, run } from "./db";
import { nowString, randomId, randomString } from "./ids";
import { hashPassword } from "./password";
import { ensureSettingsRow } from "./settings";

let pending: Promise<void> | null = null;
type AfterSystem = (db: D1Database) => Promise<unknown>;

// Runs once per isolate; idempotent across isolates (INSERT OR IGNORE on unique keys).
// `afterSystem` runs after the system tables exist (used for the bundled pb_migrations).
export function ensureBootstrapped(db: D1Database, afterSystem?: AfterSystem): Promise<void> {
  return (pending ??= bootstrap(db, afterSystem).catch((err) => {
    pending = null;
    throw err;
  }));
}

async function bootstrap(db: D1Database, afterSystem?: AfterSystem): Promise<void> {
  const existing = new Set((await all<{ name: string }>(db, "SELECT name FROM `_collections` WHERE system = 1")).map((r) => r.name));
  const now = nowString();
  for (const c of systemCollections()) {
    if (existing.has(c.name)) continue;
    await insertCollection(db, c, now);
  }
  if (existing.size === 0) invalidateCollections();
  await ensureSettingsRow(db);
  await upsertSuperuserFromEnv(db);
  if (afterSystem) await afterSystem(db);
}

export async function insertCollection(db: D1Database, c: Collection, now = nowString()): Promise<void> {
  await run(
    db,
    "INSERT OR IGNORE INTO `_collections` (id, system, type, name, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [c.id, c.system, c.type, c.name, JSON.stringify(c.fields), JSON.stringify(c.indexes),
      c.listRule, c.viewRule, c.createRule, c.updateRule, c.deleteRule, JSON.stringify(c.options), c.created || now, c.updated || now],
  );
}

// Mirrors `pocketbase superuser upsert EMAIL PASS` from env, so a fresh deploy has a way in.
async function upsertSuperuserFromEnv(db: D1Database): Promise<void> {
  const email = voidEnv.VOIDBASE_SUPERUSER_EMAIL;
  const password = voidEnv.VOIDBASE_SUPERUSER_PASSWORD;
  if (!email || !password) return;
  await upsertSuperuser(db, email, password);
}

// `pocketbase superuser upsert EMAIL PASS`
export async function upsertSuperuser(db: D1Database, email: string, password: string): Promise<"created" | "updated" | "unchanged"> {
  const table = ident("_superusers");
  const existing = await one(db, `SELECT id, password FROM ${table} WHERE email = ? LIMIT 1`, [email]);
  const now = nowString();
  if (existing) {
    // Only rehash when the stored hash no longer matches the configured password (cheap check first).
    const { verifyPassword } = await import("./password");
    if (await verifyPassword(password, String(existing.password ?? ""))) return "unchanged";
    await run(db, `UPDATE ${table} SET password = ?, tokenKey = ?, updated = ? WHERE id = ?`, [
      await hashPassword(password), randomString(50), now, existing.id,
    ]);
    return "updated";
  }
  await run(
    db,
    `INSERT OR IGNORE INTO ${table} (id, password, tokenKey, email, emailVisibility, verified, created, updated) VALUES (?,?,?,?,?,?,?,?)`,
    [randomId(), await hashPassword(password), randomString(50), email, false, true, now, now],
  );
  return "created";
}
