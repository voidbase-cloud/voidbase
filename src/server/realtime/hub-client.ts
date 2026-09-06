// The Worker side of the realtime hub (src/server/hub.ts): a per-instance Durable Object reached through the HUB
// binding the deploy declares. Record writes publish change events to it, each SSE connection holds one hibernatable
// WebSocket to it, and subscription changes made on another isolate are relayed through it. Without the binding
// (the Bun runtime, or a deploy without the hub) everything falls back to the D1 change feed and its poll loop.
import { logger } from "#platform/log";
import type { Bindings, Row } from "../types";

export interface ChangeEvent { collection: string; recordId: string; action: "create" | "update" | "delete" | "message"; data?: Row | null }
export type HubMessage =
  | { t: "changes"; changes: ChangeEvent[] }
  | { t: "subs"; subscriptions: string[]; token: string }
  | { t: "message"; event: string; data: unknown };

let hub: DurableObjectNamespace | undefined;
export function attachHub(env: Bindings): void { hub = env.HUB; }
export const hubActive = (): boolean => !!hub;

const stub = () => hub!.get(hub!.idFromName("hub"));
const post = async (path: string, body: unknown): Promise<Response> => stub().fetch(`https://hub${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Fans the changes out to every connected client that subscribed to one of their collections. */
export async function publishChanges(changes: ChangeEvent[]): Promise<void> {
  if (!hub || !changes.length) return;
  try { const r = await post("/publish", { changes }); if (!r.ok) logger.error("voidbase: hub publish failed", { status: r.status }); }
  catch (err) { logger.error("voidbase: hub publish failed", { error: err instanceof Error ? err.message : String(err) }); }
}
/** One-off message to one client (the OAuth2 redirect hand-off). */
export async function publishToClient(clientId: string, event: string, data: unknown): Promise<boolean> {
  if (!hub) return false;
  const r = await post("/client", { clientId, event, data });
  return r.ok && ((await r.json()) as { delivered: number }).delivered > 0;
}
/** Tells the isolate holding the client's stream about its new subscriptions (set through any isolate). */
export async function controlClient(clientId: string, subscriptions: string[], token: string): Promise<void> {
  if (!hub) return;
  try { await post("/control", { clientId, subscriptions, token }); } catch (err) { logger.error("voidbase: hub control failed", { error: err instanceof Error ? err.message : String(err) }); }
}

/** Opens this connection's socket to the hub (owned by the SSE request, like the stream it feeds). */
export async function openHubSocket(clientId: string): Promise<WebSocket> {
  const res = await stub().fetch(`https://hub/ws?client=${encodeURIComponent(clientId)}`, { headers: { upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`hub refused the socket (${res.status})`);
  ws.accept();
  return ws;
}
/** The collections this connection wants (names), so the hub skips everything else; "*" when it cannot say. */
export function sendFilter(ws: WebSocket, collections: string[] | "*"): void {
  try { ws.send(JSON.stringify({ t: "filter", collections })); } catch { /* closing */ }
}
