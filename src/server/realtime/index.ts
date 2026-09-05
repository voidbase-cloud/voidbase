// Realtime (decision d5): PocketBase's SSE protocol on void/sse, fanned out through the _changes table in D1.
//
// Workers bind timers and I/O objects to the request that created them, so a module-level poller dies with
// the connection that started it and a stream may only be written from its own request. Every connection
// therefore runs its own poll loop inside its request; the loops in one isolate share the last change-feed
// query result (plain data) so the D1 read cost stays near one query per second per isolate. Zero cost when
// nobody is connected.
import type { Context } from "hono";
import { eventStream } from "void/sse";
import type { Collection } from "../collections/model";
import { loadCollections } from "../collections/model";
import { one, stmt } from "../db";
import { badRequest, notFound } from "../errors";
import { nowString, randomString } from "../ids";
import { findAuthRecordByToken, isSuperuser } from "../auth";
import { enrich, fetchRecord, recordMatchesRule, type RecordContext } from "../records/service";
import { rowToValues } from "../records/values";
import type { AppEnv, Row } from "../types";

interface Subscription { topic: string; collection: string; recordId: string | null; query: Record<string, string>; headers: Record<string, string> }
interface Change { id: number; collection: string; recordId: string; action: string; data: string | null }
interface Client {
  id: string;
  cursor: number;
  subs: Subscription[];
  token: string;
  send: (event: string, data: unknown) => Promise<void>;
  closed: boolean;
}

const clients = new Map<string, Client>();
const POLL_MS = 1000;
const CHANGES_LIMIT = 500;
// last change-feed read in this isolate, shared by every connection loop (data only, never I/O objects)
let lastRead: { at: number; since: number; changes: Change[] } | null = null;

export function parseSubscription(raw: string): Subscription | null {
  const [topicPart, optionsPart] = raw.split("?options=");
  const topic = topicPart ?? "";
  const m = /^([^/]+)\/(.+)$/.exec(topic);
  if (!m) return null;
  let query: Record<string, string> = {}, headers: Record<string, string> = {};
  if (optionsPart) {
    try {
      const o = JSON.parse(decodeURIComponent(optionsPart)) as { query?: Record<string, string>; headers?: Record<string, string> };
      query = o.query ?? {};
      headers = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    } catch { /* ignore malformed options */ }
  }
  return { topic: raw, collection: m[1]!, recordId: m[2] === "*" ? null : m[2]!, query, headers };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// GET /api/realtime
export async function connect(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  const clientId = randomString(40);
  const token = c.req.header("Authorization")?.replace(/^bearer /i, "") ?? "";
  const now = nowString();
  await stmt(env.DB, "INSERT INTO `_realtime_clients` (id, subscriptions, token, created, updated) VALUES (?, '[]', ?, ?, ?)", [clientId, token, now, now]).run();
  const max = await one<{ m: number | null }>(env.DB, "SELECT MAX(id) AS m FROM `_changes`");
  const cursor = max?.m ?? 0;
  return eventStream(
    async (stream) => {
      const client: Client = {
        id: clientId, cursor, subs: [], token, closed: false,
        send: async (event, data) => { await stream.send({ event, data }); },
      };
      clients.set(clientId, client);
      await stream.send({ id: clientId, event: "PB_CONNECT", data: { clientId } });
      const loop = (async () => {
        while (!client.closed) {
          await sleep(POLL_MS);
          if (client.closed) break;
          try { await pollOne(env, client); } catch (err) { if (!client.closed) console.error("voidbase: realtime poll failed", err); }
        }
      })();
      await stream.closed;
      client.closed = true;
      clients.delete(clientId);
      await loop.catch(() => {});
      try { await stmt(env.DB, "DELETE FROM `_realtime_clients` WHERE id = ?", [clientId]).run(); } catch { /* best effort */ }
    },
    { signal: c.req.raw.signal, keepAlive: { intervalMs: 15000, comment: "" } },
  );
}

// POST /api/realtime  {clientId, subscriptions: []}
export async function setSubscriptions(c: Context<AppEnv>): Promise<Response> {
  let body: { clientId?: string; subscriptions?: string[] } = {};
  try {
    const ct = c.req.header("content-type") ?? "";
    body = ct.includes("json") ? await c.req.json() : (Object.fromEntries((await c.req.formData()).entries()) as unknown as typeof body);
  } catch { throw badRequest("Failed to read the submitted data."); }
  const clientId = String(body.clientId ?? "");
  const subs = Array.isArray(body.subscriptions) ? body.subscriptions.map(String) : [];
  if (!clientId) throw badRequest("An error occurred while validating the submitted data.", { clientId: { code: "validation_required", message: "Cannot be blank." } });
  const row = await one(c.env.DB, "SELECT id FROM `_realtime_clients` WHERE id = ?", [clientId]);
  if (!row) throw notFound("Missing or invalid client id.");
  const token = c.req.header("Authorization")?.replace(/^bearer /i, "") ?? "";
  await stmt(c.env.DB, "UPDATE `_realtime_clients` SET subscriptions = ?, token = ?, updated = ? WHERE id = ?", [JSON.stringify(subs), token, nowString(), clientId]).run();
  const local = clients.get(clientId);
  if (local) { local.subs = subs.map(parseSubscription).filter((s): s is Subscription => !!s); local.token = token; }
  return c.body(null, 204);
}

// One tick for one connection: refresh its subscriptions (they may have been set through another isolate),
// read the change feed past its cursor (reusing this isolate's last read when it covers the range) and deliver.
async function pollOne(env: AppEnv["Bindings"], cl: Client) {
  const db = env.DB;
  const now = Date.now();
  const reuse = lastRead && now - lastRead.at < POLL_MS && lastRead.since <= cl.cursor && lastRead.changes.length < CHANGES_LIMIT ? lastRead : null;
  const statements = [stmt(db, "SELECT subscriptions, token FROM `_realtime_clients` WHERE id = ?", [cl.id])];
  if (!reuse) statements.push(stmt(db, "SELECT id, collection, recordId, action, data FROM `_changes` WHERE id > ? ORDER BY id ASC LIMIT ?", [cl.cursor, CHANGES_LIMIT]));
  const results = await db.batch(statements);
  const me = (results[0]?.results?.[0] ?? null) as { subscriptions: string; token: string } | null;
  if (me) {
    cl.subs = (JSON.parse(me.subscriptions || "[]") as string[]).map(parseSubscription).filter((s): s is Subscription => !!s);
    cl.token = me.token;
  }
  let changes: Change[];
  if (reuse) changes = reuse.changes.filter((ch) => ch.id > cl.cursor);
  else {
    changes = (results[1]?.results ?? []) as unknown as Change[];
    lastRead = { at: now, since: cl.cursor, changes };
  }
  if (!changes.length) return;
  const collections = await loadCollections(db);
  for (const ch of changes) {
    if (cl.closed) return;
    cl.cursor = Math.max(cl.cursor, ch.id);
    const matching = cl.subs.filter((s) => (s.collection === ch.collection || collections.get(s.collection)?.name === ch.collection) && (s.recordId === null || s.recordId === ch.recordId));
    if (!matching.length) continue;
    const collection = collections.get(ch.collection);
    if (!collection) continue;
    for (const sub of matching) {
      try { await deliver(db, env, cl, sub, collection, ch, collections); } catch (err) { if (!cl.closed) console.error("voidbase: realtime deliver failed", err); }
    }
  }
}

async function deliver(db: D1Database, bindings: AppEnv["Bindings"], cl: Client, sub: Subscription, collection: Collection, ch: Change, collections: Map<string, Collection>) {
  const token = sub.headers.authorization?.replace(/^bearer /i, "") || cl.token;
  const auth = token ? await findAuthRecordByToken(db, token) : null;
  const ctx: RecordContext = {
    db, storage: bindings.STORAGE, auth, superuser: isSuperuser(auth),
    request: { auth: auth ? { collection: auth.collection, row: auth.row } : null, method: "GET", query: sub.query, headers: sub.headers, body: {}, context: "realtime" },
    collections,
  };
  const rule = sub.recordId === null ? collection.listRule : collection.viewRule;
  let row: Row | null = null;
  if (ch.action === "delete") {
    if (!ch.data) return;
    row = JSON.parse(ch.data) as Row;
    if (!ctx.superuser) {
      if (rule === null) return;
      if (rule.trim() !== "" && !(await recordMatchesRule(ctx, collection, rule, rowToValues(collection, row)))) return;
    }
  } else {
    try { row = await fetchRecord(ctx, collection, ch.recordId, rule); } catch { row = null; }
    if (!row) return; // gone, or not visible to this subscriber
  }
  const [record] = await enrich(ctx, collection, [row], { expand: sub.query.expand, fields: sub.query.fields });
  if (cl.closed) return;
  await cl.send(sub.topic, { action: ch.action, record });
}
