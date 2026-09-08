// The hub as a service rather than a module-level variable.
//
// hub-client.ts keeps `let hub` and sets it from `attachHub(env)` on every request, which is an implicit global: a
// caller cannot tell whether it has been set, so every function in that file opens with `if (!hub) return`. As a
// service the question is answered once, at composition: the binding either exists, in which case the service does,
// or it does not and nothing that injects it loads. The guards go away with the global.
//
// Realtime itself still has to work without a hub, falling back to the D1 change feed, so realtime injects it
// optionally rather than requiring it. That is the distinction cordis is for: "I need this" and "I use this if it
// is here" are different declarations, and both are visible at the top of the plugin rather than buried in a
// conditional halfway down.
import { Service } from "cordis";
import { logger } from "#platform/log";
import type { Context } from "cordis";
import type { ChangeEvent } from "./hub-client";

export class HubService extends Service {
  constructor(ctx: Context, private ns: DurableObjectNamespace) {
    super(ctx, "hub");
  }

  private stub() { return this.ns.get(this.ns.idFromName("hub")); }

  private post(path: string, body: unknown): Promise<Response> {
    return this.stub().fetch(`https://hub${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** fans the changes out to every connected client subscribed to one of their collections */
  async publishChanges(changes: ChangeEvent[]): Promise<void> {
    if (!changes.length) return;
    try {
      const r = await this.post("/publish", { changes });
      if (!r.ok) logger.error("voidbase: hub publish failed", { status: r.status });
    } catch (err) {
      logger.error("voidbase: hub publish failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async presence(op: string, member: unknown, o: { max: number; ttlMs: number }): Promise<{ members: unknown[]; holdsSlot: boolean } | null> {
    try {
      const r = await this.post("/presence", { op, member, max: o.max, ttlMs: o.ttlMs });
      if (!r.ok) { logger.error("voidbase: hub presence failed", { status: r.status }); return null; }
      return (await r.json()) as { members: unknown[]; holdsSlot: boolean };
    } catch (err) {
      logger.error("voidbase: hub presence failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** one-off message to one client (the OAuth2 redirect hand-off) */
  async publishToClient(clientId: string, event: string, data: unknown): Promise<boolean> {
    const r = await this.post("/client", { clientId, event, data });
    return r.ok && ((await r.json()) as { delivered: number }).delivered > 0;
  }

  /** tells the isolate holding the client's stream about its new subscriptions */
  async controlClient(clientId: string, subscriptions: string[], token: string): Promise<void> {
    try { await this.post("/control", { clientId, subscriptions, token }); }
    catch (err) { logger.error("voidbase: hub control failed", { error: err instanceof Error ? err.message : String(err) }); }
  }

  /** opens this connection's socket to the hub, owned by the SSE request like the stream it feeds */
  async openSocket(clientId: string): Promise<WebSocket> {
    const res = await this.stub().fetch(`https://hub/ws?client=${encodeURIComponent(clientId)}`, { headers: { upgrade: "websocket" } });
    const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket;
    if (!ws) throw new Error(`hub refused the socket (${res.status})`);
    ws.accept();
    return ws;
  }
}

declare module "cordis" {
  interface Context {
    hub: HubService;
  }
}
