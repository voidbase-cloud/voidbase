// POST /api/sql (apis/sql.go, the panel's SQL console): superuser-only raw SQL against D1, at most 1000 rows.
import type { Hono } from "hono";
import { requireSuperuser } from "./auth-slot";
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
      // database/sql reports a declared type only for plain column references; expressions and aliases of them are ""
      const sel = /^SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\s/i.exec(trimmed);
      const plain = new Map<string, string>(); let star = false;
      if (sel) {
        const items: string[] = []; let depth = 0, cur = "", quote = "";
        for (const ch of sel[1]!) {
          if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
          if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
          if (ch === "(") depth++; if (ch === ")") depth--;
          if (ch === "," && depth === 0) { items.push(cur); cur = ""; } else cur += ch;
        }
        items.push(cur);
        for (const item of items) {
          const t = item.trim();
          if (t === "*" || /^\w+\.\*$/.test(t)) { star = true; continue; }
          const m = /^(?:[\w`"]+\.)?[`"]?(\w+)[`"]?(?:\s+(?:AS\s+)?[`"]?(\w+)[`"]?)?$/i.exec(t);
          if (m) plain.set(m[2] ?? m[1]!, m[1]!);
        }
      }
      const columns = names.map((name) => ({ name, type: plain.has(name) ? declared.get(plain.get(name)!) ?? "" : star ? declared.get(name) ?? "" : "", nullable: true }));
      return c.json({ execTime: Date.now() - started, affectedRows: 0, columns, rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/^D1_ERROR: /, "") : String(err);
      throw badRequest("Failed to execute query. Raw error:\n" + msg);
    }
  });
}
