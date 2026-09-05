// POST /api/sql (apis/sql.go, the panel's SQL console): superuser-only raw SQL against D1, at most 1000 rows.
import type { Hono } from "hono";
import { requireSuperuser } from "./auth";
import { ApiError, badRequest } from "./errors";
import type { AppEnv } from "./types";

const MAX_ROWS = 1000;
const WRITE_PREFIXES = ["INSERT", "CREATE", "UPDATE", "DELETE", "DROP", "DETACH", "ALTER", "REPLACE"];

export function mountSqlApi(app: Hono<AppEnv>) {
  app.post("/api/sql", async (c) => {
    requireSuperuser(c);
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) ?? {}; } catch { throw badRequest("An error occurred while loading the submitted data."); }
    const query = String(body.query ?? "");
    if (!query) throw new ApiError(400, "An error occurred while validating the submitted data.", { query: { code: "validation_required", message: "Cannot be blank." } } as never);
    if (query.length > 5000) throw new ApiError(400, "An error occurred while validating the submitted data.", { query: { code: "validation_length_too_long", message: "The length must be no more than 5000.", params: { max: 5000, min: 0 } } } as never);
    const trimmed = query.trim();
    const upper = trimmed.toUpperCase();
    const isWrite = !upper.startsWith("SELECT") && WRITE_PREFIXES.some((p) => upper.startsWith(p));
    const started = Date.now();
    try {
      if (isWrite) {
        const res = await c.env.DB.prepare(trimmed).run();
        return c.json({ execTime: Date.now() - started, affectedRows: Number(res.meta?.changes ?? 0), columns: [], rows: [] });
      }
      const raw = await c.env.DB.prepare(trimmed).raw({ columnNames: true }) as unknown[][];
      const names = (raw[0] ?? []) as string[];
      // database/sql scans every value as a string; column types come from the table declarations
      const rows = raw.slice(1, 1 + MAX_ROWS).map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))));
      const declared = new Map<string, string>();
      for (const table of [...trimmed.matchAll(/\b(?:FROM|JOIN)\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/gi)].map((m) => m[1]!)) {
        try { for (const col of await c.env.DB.prepare(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all<{ name: string; type: string }>().then((r) => r.results)) if (!declared.has(col.name)) declared.set(col.name, col.type); } catch { /* not a table */ }
      }
      const columns = names.map((name) => ({ name, type: declared.get(name) ?? "", nullable: true }));
      return c.json({ execTime: Date.now() - started, affectedRows: 0, columns, rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/^D1_ERROR: /, "") : String(err);
      throw badRequest("Failed to execute query. Raw error:\n" + msg);
    }
  });
}
