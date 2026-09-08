// Realtime (decision d5): PocketBase's SSE protocol on void/sse. Two transports behind the same protocol:
//
// - the hub (HUB binding, src/server/hub.ts): every connection holds one hibernatable WebSocket to the instance's
//   Durable Object, record writes publish to it, subscription changes are relayed through it. Push, no polling,
//   nothing shared between instances.
// - the D1 change feed (no binding: the Bun runtime, a deploy without the hub): every connection runs a poll loop
//   inside its request; the loops in one isolate share the last query result (plain data), about one D1 read per
//   second per isolate, zero when nobody is connected.
//
// Workers bind timers and I/O objects to the request that created them, so both the poll loop and the hub socket
// live inside the SSE request, and a stream is only ever written from its own request.
import type { Context } from "hono";
import { eventStream } from "#platform/sse";
import type { Collection } from "../collections/model";
import { loadCollections } from "../collections/model";
import { one, stmt } from "../db";
import { badRequest, notFound } from "../errors";
import { nowString, randomString } from "../ids";
import { findAuthRecordByToken, isSuperuser } from "../auth";
import { enrich, fetchRecord, recordMatchesRule, type RecordContext } from "../records/service";
import { rowToValues } from "../records/values";
import { trigger } from "../hooks/runtime";
import { PRESENCE_TOPIC } from "./presence";
import type { AppEnv, Row } from "../types";
import { realtimeFor, sendFilter, type ChangeEvent, type HubMessage } from "./hub-client";

interface Subscription { topic: string; collection: string; recordId: string | null; query: Record<string, string>; headers: Record<string, string> }
interface Change { id: number; collection: string; recordId: string; action: string; data: string | null }
interface Client {
  id: string;
  cursor: number;
  subs: Subscription[];
  token: string;
  send: (event: string, data: unknown) => Promise<void>;
  closed: boolean;
  hub?: WebSocket | null;
}

const clients = new Map<string, Client>();
const POLL_MS = 1000;
const CHANGES_LIMIT = 500;
// last change-feed read in this isolate, shared by every connection loop (data only, never I/O objects)
let lastRead: { at: number; since: number; changes: Change[] } | null = null;

export function parseSubscription(raw: string): Subscription | null {
  const [topicPart, optionsPart] = raw.split("?options=");
  const topic = topicPart ?? "";
  if (topic.startsWith("@")) return { topic: raw, collection: topic, recordId: null, query: {}, headers: {} }; // @oauth2 and friends: messages, not records
  if (topic === PRESENCE_TOPIC) return { topic: raw, collection: PRESENCE_TOPIC, recordId: null, query: {}, headers: {} }; // who is here now, not a collection
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
  const realtime = c.get("realtime");
  const useHub = realtime.active();
  const max = useHub ? null : await one<{ m: number | null }>(env.DB, "SELECT MAX(id) AS m FROM `_changes`");
  const cursor = max?.m ?? 0;
  return eventStream(
    async (stream) => {
      const client: Client = {
        id: clientId, cursor, subs: [], token, closed: false,
        send: async (event, data) => { await stream.send({ event, data }); },
      };
      clients.set(clientId, client);
      let hubSocket: WebSocket | null = null;
      if (useHub) {
        // the socket belongs to this request, like the stream it feeds; if the hub is unreachable the stream ends
        // and the SDK reconnects, since writers publish there instead of writing feed rows
        try { hubSocket = await realtime.openSocket(clientId); client.hub = hubSocket; } catch (err) { console.error("voidbase: realtime hub unreachable", err); stream.close(); return; }
        hubSocket.addEventListener("message", (e) => { void onHubMessage(env, client, String(e.data)).catch((err) => { if (!client.closed) console.error("voidbase: realtime hub message failed", err); }); });
        hubSocket.addEventListener("close", () => { if (!client.closed) stream.close(); });
        hubSocket.addEventListener("error", () => { if (!client.closed) stream.close(); });
        // a torn-down request may never reach the cleanup below: close the hub socket on abort as well
        c.req.raw.signal.addEventListener("abort", () => { try { hubSocket?.close(1000, "client gone"); } catch { /* gone */ } });
      }
      await stream.send({ id: clientId, event: "PB_CONNECT", data: { clientId } });
      const loop = useHub ? (async () => {
        // a keepalive the object answers without waking; the race lets the loop end as soon as the stream does
        while (!client.closed) { await Promise.race([sleep(60_000), stream.closed]); if (client.closed) break; try { hubSocket?.send("ping"); } catch { stream.close(); } }
      })() : (async () => {
        while (!client.closed) {
          await sleep(POLL_MS);
          if (client.closed) break;
          try { await pollOne(env, client); } catch (err) { if (!client.closed) console.error("voidbase: realtime poll failed", err); }
        }
      })();
      await stream.closed;
      client.closed = true;
      clients.delete(clientId);
      try { hubSocket?.close(); } catch { /* already closed */ }
      await loop.catch(() => {});
      try { await stmt(env.DB, "DELETE FROM `_realtime_clients` WHERE id = ?", [clientId]).run(); } catch { /* best effort */ }
    },
    { signal: c.req.raw.signal, keepAlive: { intervalMs: 15000, comment: "" } },
  );
}

// a frame from the hub: changes to deliver, this client's new subscriptions, or a one-off message
async function onHubMessage(env: AppEnv["Bindings"], cl: Client, raw: string) {
  if (raw === "pong") return;
  const msg = JSON.parse(raw) as HubMessage;
  if (msg.t === "subs") { applySubscriptions(cl, msg.subscriptions, msg.token); await announceFilter(env, cl); return; }
  if (msg.t === "message") {
    if (!cl.subs.some((s) => s.topic === msg.event)) return;
    await cl.send(msg.event, msg.data ?? {});
    cl.subs = cl.subs.filter((s) => s.topic !== msg.event);
    await stmt(env.DB, "UPDATE `_realtime_clients` SET subscriptions = ?, updated = ? WHERE id = ?", [JSON.stringify(cl.subs.map((s) => s.topic)), nowString(), cl.id]).run();
    return;
  }
  if (msg.t === "changes") {
    const collections = await loadCollections(env.DB);
    for (const ch of msg.changes) { if (cl.closed) return; await dispatch(env, cl, { id: 0, collection: ch.collection, recordId: ch.recordId, action: ch.action, data: ch.data ? JSON.stringify(ch.data) : null }, collections); }
  }
}
function applySubscriptions(cl: Client, subs: string[], token: string) {
  cl.subs = subs.map(parseSubscription).filter((s): s is Subscription => !!s);
  cl.token = token;
}
// tell the hub which collections this connection wants (names; ids are resolved), so it skips the rest
async function announceFilter(env: AppEnv["Bindings"], cl: Client) {
  const ws = cl.hub; if (!ws) return;
  const collections = await loadCollections(env.DB);
  const names = new Set<string>();
  for (const s of cl.subs) { if (s.collection.startsWith("@")) continue; const col = collections.get(s.collection); names.add(col ? col.name : s.collection); }
  sendFilter(ws, [...names]);
}

// POST /api/realtime  {clientId, subscriptions: []}
export async function setSubscriptions(c: Context<AppEnv>, pre?: { clientId?: string; subscriptions?: string[] }): Promise<Response> {
  let body: { clientId?: string; subscriptions?: string[] } = pre ?? {};
  if (!pre) {
    try {
      const ct = c.req.header("content-type") ?? "";
      body = ct.includes("json") ? await c.req.json() : (Object.fromEntries((await c.req.formData()).entries()) as unknown as typeof body);
    } catch { throw badRequest(); }
  }
  const clientId = String(body.clientId ?? "");
  const subs = Array.isArray(body.subscriptions) ? body.subscriptions.map(String) : [];
  if (!clientId) throw badRequest("An error occurred while validating the submitted data.", { clientId: { code: "validation_required", message: "Cannot be blank." } });
  const row = await one(c.env.DB, "SELECT id FROM `_realtime_clients` WHERE id = ?", [clientId]);
  if (!row) throw notFound("Missing or invalid client id.");
  const token = c.req.header("Authorization")?.replace(/^bearer /i, "") ?? "";
  await stmt(c.env.DB, "UPDATE `_realtime_clients` SET subscriptions = ?, token = ?, updated = ? WHERE id = ?", [JSON.stringify(subs), token, nowString(), clientId]).run();
  const local = clients.get(clientId);
  if (local) { applySubscriptions(local, subs, token); if (local.hub) await announceFilter(c.env, local); }
  else { const realtime = c.get("realtime"); if (realtime.active()) await realtime.controlClient(clientId, subs, token); } // the stream lives in another isolate
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
    await dispatch(env, cl, ch, collections);
  }
}

// one change for one connection: the OAuth2 hand-off, or every matching subscription through the rules
async function dispatch(env: AppEnv["Bindings"], cl: Client, ch: Change, collections: Map<string, Collection>) {
  const db = env.DB;
  if (ch.collection.startsWith("@")) { // one-off message for a single client (OAuth2 redirect handoff)
    if (ch.recordId === cl.id && cl.subs.some((s) => s.topic === ch.collection)) {
      await cl.send(ch.collection, ch.data ? JSON.parse(ch.data) : {});
      cl.subs = cl.subs.filter((s) => s.topic !== ch.collection);
      await stmt(db, "UPDATE `_realtime_clients` SET subscriptions = ?, updated = ? WHERE id = ?", [JSON.stringify(cl.subs.map((s) => s.topic)), nowString(), cl.id]).run();
    }
    return;
  }
  if (ch.collection === PRESENCE_TOPIC) { // the roster, fanned out by the hub: no collection to read, no rule to apply
    if (cl.subs.some((s) => s.topic === PRESENCE_TOPIC)) await cl.send(PRESENCE_TOPIC, ch.data ? (JSON.parse(ch.data) as unknown) : {});
    return;
  }
  const matching = cl.subs.filter((s) => (s.collection === ch.collection || collections.get(s.collection)?.name === ch.collection) && (s.recordId === null || s.recordId === ch.recordId));
  if (!matching.length) return;
  const collection = collections.get(ch.collection);
  if (!collection) return;
  for (const sub of matching) {
    try { await deliver(db, env, cl, sub, collection, ch, collections); } catch (err) { if (!cl.closed) console.error("voidbase: realtime deliver failed", err); }
  }
}

async function deliver(db: D1Database, bindings: AppEnv["Bindings"], cl: Client, sub: Subscription, collection: Collection, ch: Change, collections: Map<string, Collection>) {
  const token = sub.headers.authorization?.replace(/^bearer /i, "") || cl.token;
  const auth = token ? await findAuthRecordByToken(db, token) : null;
  const ctx: RecordContext = {
    db, storage: bindings.STORAGE, auth, superuser: isSuperuser(auth),
    request: { auth: auth ? { collection: auth.collection, row: auth.row } : null, method: "GET", query: sub.query, headers: sub.headers, body: {}, context: "realtime" },
    collections,
    realtime: realtimeFor(bindings),
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
  const ev = { app: undefined as unknown, client: { id: cl.id, subscriptions: cl.subs.map((s) => s.topic) }, message: { name: sub.topic, data: { action: ch.action, record } }, next: async () => undefined as unknown };
  await trigger("onRealtimeMessageSend", ev, null, async () => { if (!cl.closed) await cl.send(ev.message.name, ev.message.data); });
}
