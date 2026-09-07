/// <reference types="@cloudflare/workers-types" />
// The realtime hub: one SQLite-backed Durable Object per voidbase instance, exported from the instance's own Worker
// (hooks-plugin appends it to Void's generated entry; the deploy's wrangler.jsonc declares the HUB binding and the
// new_sqlite_classes migration), so no two instances share it or anything else. Every SSE connection holds one
// hibernatable WebSocket here; a record write POSTs /publish and the object sends the change to the sockets whose
// filter includes the collection, then goes back to sleep. Nothing is stored beyond each socket's attachment.
import { PRESENCE_RECORD, PRESENCE_TOPIC, publicMembers, rosterAfter, type PresenceInput, type PresenceMember, type PresenceOp } from "./realtime/presence";

interface Attachment { id: string; all: boolean; collections: string[]; since: number }
interface Change { collection: string; recordId: string; action: string; data?: unknown }

export class VoidbaseHub implements DurableObject {
  // Presence lives in memory only: a roster of who is here now (src/server/realtime/presence.ts). Losing it when
  // the object hibernates costs nothing -- the members re-join on their next beat, and nothing was worth storing.
  private presence: PresenceMember[] = [];

  constructor(private readonly state: DurableObjectState) {
    // keepalive answered without waking the object; the alarm sweeps sockets that stopped pinging
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Connections ping every minute (auto-answered). A Worker whose request was torn down never closes its socket, so
  // every few minutes the object drops sockets whose last ping is older than two intervals.
  async alarm(): Promise<void> {
    const open = this.sweep(150_000);
    await this.state.storage.put("lastSweep", Date.now());
    if (open) await this.state.storage.setAlarm(Date.now() + 120_000);
  }
  // closes sockets that have not pinged for staleMs; returns how many stay open
  private sweep(staleMs: number): number {
    const stale = Date.now() - staleMs;
    let open = 0;
    for (const ws of this.state.getWebSockets()) {
      const seen = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? this.attachment(ws).since;
      if (seen < stale) { try { ws.close(1001, "stale"); } catch { /* gone */ } } else open++;
    }
    return open;
  }
  private async armSweep(): Promise<void> { if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + 120_000); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const clientId = url.searchParams.get("client") ?? "";
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], clientId ? [clientId] : []);
      pair[1].serializeAttachment({ id: clientId, all: true, collections: [], since: Date.now() } satisfies Attachment);
      await this.armSweep();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/stats") return Response.json({ sockets: this.state.getWebSockets().length, alarm: await this.state.storage.getAlarm(), lastSweep: (await this.state.storage.get<number>("lastSweep")) ?? null });
    if (req.method !== "POST") return new Response("Not Found", { status: 404 });
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname === "/sweep") { const before = this.state.getWebSockets().length; const open = this.sweep(Number(body.staleMs ?? 150_000)); return Response.json({ before, closed: before - open, open, after: this.state.getWebSockets().length }); }
    if (url.pathname === "/publish") return Response.json({ delivered: this.fanout((body.changes ?? []) as Change[]) });
    if (url.pathname === "/presence") {
      // one request updates the roster and fans it out: the object is already awake for the socket loop
      const { members, changed, member } = rosterAfter(this.presence, String(body.op ?? "beat") as PresenceOp, (body.member ?? {}) as PresenceInput, {
        max: Number(body.max ?? 3), ttlMs: Number(body.ttlMs ?? 12_000), now: Date.now(),
      });
      this.presence = members;
      const holds = !!member && members.some((m) => m.id === member.id);
      if (changed) this.fanout([{ collection: PRESENCE_TOPIC, recordId: PRESENCE_RECORD, action: "message", data: { members: publicMembers(members) } }]);
      return Response.json({ members: publicMembers(members), holdsSlot: holds });
    }
    if (url.pathname === "/client" || url.pathname === "/control") {
      const clientId = String(body.clientId ?? "");
      const msg = url.pathname === "/client" ? { t: "message", event: body.event, data: body.data } : { t: "subs", subscriptions: body.subscriptions, token: body.token };
      let delivered = 0;
      for (const ws of clientId ? this.state.getWebSockets(clientId) : []) { try { ws.send(JSON.stringify(msg)); delivered++; } catch { this.drop(ws); } }
      return Response.json({ delivered });
    }
    return new Response("Not Found", { status: 404 });
  }

  /** sends the changes to every socket whose filter includes them; returns how many were reached */
  private fanout(changes: Change[]): number {
    let delivered = 0;
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      const mine = att.all ? changes : changes.filter((ch) => att.collections.includes(ch.collection));
      if (!mine.length) continue;
      try { ws.send(JSON.stringify({ t: "changes", changes: mine })); delivered++; } catch { this.drop(ws); }
    }
    return delivered;
  }

  // the connection narrows what it wants: {t:"filter", collections:[names] | "*"}
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    try {
      const m = JSON.parse(message) as { t?: string; collections?: string[] | "*" };
      if (m.t !== "filter") return;
      const att = this.attachment(ws);
      const list = Array.isArray(m.collections) ? m.collections : null;
      const all = !list;
      const collections = list ? list.map(String).slice(0, 100) : [];
      ws.serializeAttachment({ ...att, all, collections } satisfies Attachment);
    } catch { /* ignore malformed frames */ }
  }
  webSocketClose(ws: WebSocket): void { try { ws.close(); } catch { /* already closed */ } }
  webSocketError(ws: WebSocket): void { try { ws.close(); } catch { /* already closed */ } }

  private drop(ws: WebSocket): void { try { ws.close(1011, "send failed"); } catch { /* gone */ } }
  private attachment(ws: WebSocket): Attachment {
    const att = ws.deserializeAttachment() as Attachment | null;
    return att ?? { id: "", all: true, collections: [], since: 0 };
  }
}
