// Server-sent events on a plain Response stream (the same surface as void/sse's eventStream).
export interface SSEStream { send(msg: { id?: string; event?: string; data: unknown }): Promise<void>; closed: Promise<void>; close(): void }
export function eventStream(handler: (stream: SSEStream) => Promise<void>, opts: { signal?: AbortSignal; keepAlive?: { intervalMs: number; comment?: string } } = {}): Response {
  const enc = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let done = false; let resolveClosed = () => {};
  const closed = new Promise<void>((r) => { resolveClosed = r; });
  const finish = () => { if (done) return; done = true; if (keepAlive) clearInterval(keepAlive); resolveClosed(); try { controller?.close(); } catch { /* already closed */ } };
  const write = (s: string) => { if (done) return; try { controller!.enqueue(enc.encode(s)); } catch { finish(); } };
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { finish(); } });
  const keepAlive = opts.keepAlive ? setInterval(() => write(`: ${opts.keepAlive!.comment ?? ""}\n\n`), opts.keepAlive.intervalMs) : null;
  opts.signal?.addEventListener("abort", finish);
  const stream: SSEStream = {
    async send({ id, event, data }) {
      let msg = ""; if (id) msg += `id: ${id}\n`; if (event) msg += `event: ${event}\n`;
      for (const l of (typeof data === "string" ? data : JSON.stringify(data)).split("\n")) msg += `data: ${l}\n`;
      write(msg + "\n");
    },
    closed, close: finish,
  };
  handler(stream).catch((e) => console.error("voidbase: sse handler failed", e)).finally(finish);
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" } });
}
