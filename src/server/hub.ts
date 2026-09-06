/// <reference types="@cloudflare/workers-types" />
// A per-instance realtime hub: one SQLite-backed Durable Object class exported from the instance's own Worker, so no
// two voidbase instances share it (or anything else). Edge isolates that hold SSE clients connect over a hibernatable
// WebSocket; a record write POSTs /publish and the object fans the event out to every connected isolate, then goes
// back to sleep. Without the HUB binding the realtime feed keeps polling D1 (src/server/realtime).
export class VoidbaseHub implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]); // hibernation API: the object sleeps between messages
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/publish" && req.method === "POST") {
      const body = await req.text();
      let delivered = 0;
      for (const ws of this.state.getWebSockets()) { try { ws.send(body); delivered++; } catch { /* closing */ } }
      return Response.json({ delivered });
    }
    if (url.pathname === "/stats") return Response.json({ sockets: this.state.getWebSockets().length });
    return new Response("Not Found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }
  webSocketClose(ws: WebSocket): void { try { ws.close(); } catch { /* already closed */ } }
}
