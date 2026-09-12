// cloudflare:sockets `connect` on node:net / node:tls (Bun): readable/writable web streams and STARTTLS upgrade.
import net from "node:net";
import tls from "node:tls";
export interface Socket { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; closed: Promise<void>; close(): void; startTls(): Socket }
function wrap(sock: net.Socket, host: string): Socket {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const onData = (d: Buffer) => { try { ctrl?.enqueue(new Uint8Array(d)); } catch { /* closed */ } };
  const onEnd = () => { try { ctrl?.close(); } catch { /* closed */ } };
  const onError = (e: Error) => { try { ctrl?.error(e); } catch { /* closed */ } };
  const readable = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; sock.on("data", onData); sock.on("end", onEnd); sock.on("error", onError); } });
  const writable = new WritableStream<Uint8Array>({ write(chunk) { return new Promise<void>((res, rej) => sock.write(chunk, (e) => (e ? rej(e) : res()))); }, close() { sock.end(); } });
  return {
    readable, writable,
    closed: new Promise<void>((r) => sock.once("close", () => r())),
    close() { sock.destroy(); },
    startTls() { sock.off("data", onData); sock.off("end", onEnd); sock.off("error", onError); return wrap(tls.connect({ socket: sock, servername: host }), host); },
  };
}
export function connect(addr: { hostname: string; port: number }, opts: { secureTransport?: "on" | "off" | "starttls"; allowHalfOpen?: boolean } = {}): Socket {
  const sock = opts.secureTransport === "on" ? tls.connect({ host: addr.hostname, port: addr.port, servername: addr.hostname }) : net.connect({ host: addr.hostname, port: addr.port });
  return wrap(sock, addr.hostname);
}
