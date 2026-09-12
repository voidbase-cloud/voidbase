// The Worker side of the realtime hub (src/server/hub.ts): a per-instance Durable Object reached through the HUB
// binding the deploy declares. Record writes publish change events to it, each SSE connection holds one hibernatable
// WebSocket to it, and subscription changes made on another isolate are relayed through it. Without the binding
// (the Bun runtime, or a deploy without the hub) everything falls back to the D1 change feed and its poll loop.
//
// This used to be a module-level `let hub` set by `attachHub(env)` on every request, which is an implicit global:
// no caller could tell whether it had been set, so every function opened with `if (!hub) return`. It is a client
// now, built from the request's bindings and carried on the request, and the question "is there a hub" is asked of
// it once, by `active()`. The realtime plugin (plugins/realtime.ts) provides `realtimeFor` as the `realtime@1`
// interface; nothing else should construct these directly.
import { logger } from "#platform/log";
import type { RealtimeClient } from "../interfaces";
import type { Bindings, Row } from "../types";

export interface ChangeEvent { collection: string; recordId: string; action: "create" | "update" | "delete" | "message"; data?: Row | null }
export type HubMessage =
  | { t: "changes"; changes: ChangeEvent[] }
  | { t: "subs"; subscriptions: string[]; token: string }
  | { t: "message"; event: string; data: unknown };

const fail = (what: string, err: unknown) =>
  logger.error(`voidbase: hub ${what} failed`, { error: err instanceof Error ? err.message : String(err) });

/** the hub, when the deploy declared one */
export class HubClient implements RealtimeClient {
  constructor(private readonly ns: DurableObjectNamespace) {}
  active(): boolean { return true; }

  private stub() { return this.ns.get(this.ns.idFromName("hub")); }
  private post(path: string, body: unknown): Promise<Response> {
    return this.stub().fetch(`https://hub${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** fans the changes out to every connected client that subscribed to one of their collections */
  async publish(changes: ChangeEvent[]): Promise<void> {
    if (!changes.length) return;
    try { const r = await this.post("/publish", { changes }); if (!r.ok) logger.error("voidbase: hub publish failed", { status: r.status }); }
    catch (err) { fail("publish", err); }
  }

  /** presence: the roster lives in the hub, so one request both updates it and fans it out to the sockets that asked */
  async presence(op: string, member: unknown, o: { max: number; ttlMs: number }): Promise<{ members: unknown[]; holdsSlot: boolean } | null> {
    try {
      const r = await this.post("/presence", { op, member, max: o.max, ttlMs: o.ttlMs });
      if (!r.ok) { logger.error("voidbase: hub presence failed", { status: r.status }); return null; }
      return (await r.json()) as { members: unknown[]; holdsSlot: boolean };
    } catch (err) { fail("presence", err); return null; }
  }

  /** one-off message to one client (the OAuth2 redirect hand-off) */
  async publishToClient(clientId: string, event: string, data: unknown): Promise<boolean> {
    const r = await this.post("/client", { clientId, event, data });
    return r.ok && ((await r.json()) as { delivered: number }).delivered > 0;
  }

  /** tells the isolate holding the client's stream about its new subscriptions (set through any isolate) */
  async controlClient(clientId: string, subscriptions: string[], token: string): Promise<void> {
    try { await this.post("/control", { clientId, subscriptions, token }); } catch (err) { fail("control", err); }
  }

  /** opens this connection's socket to the hub (owned by the SSE request, like the stream it feeds) */
  async openSocket(clientId: string): Promise<WebSocket> {
    const res = await this.stub().fetch(`https://hub/ws?client=${encodeURIComponent(clientId)}`, { headers: { upgrade: "websocket" } });
    const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket;
    if (!ws) throw new Error(`hub refused the socket (${res.status})`);
    ws.accept();
    return ws;
  }
}

/** no hub: every caller falls back to the D1 change feed, and says so by asking `active()` first */
export class NoHub implements RealtimeClient {
  active(): boolean { return false; }
  async publish(): Promise<void> {}
  async presence(): Promise<null> { return null; }
  async publishToClient(): Promise<boolean> { return false; }
  async controlClient(): Promise<void> {}
  openSocket(): Promise<WebSocket> { return Promise.reject(new Error("no realtime hub is bound")); }
}

const none = new NoHub();

/** the client for this request's bindings: the whole of what the realtime plugin provides */
export function realtimeFor(env: Bindings): RealtimeClient {
  return env.HUB ? new HubClient(env.HUB) : none;
}

/** the collections this connection wants (names), so the hub skips everything else; "*" when it cannot say */
export function sendFilter(ws: WebSocket, collections: string[] | "*"): void {
  try { ws.send(JSON.stringify({ t: "filter", collections })); } catch { /* closing */ }
}
