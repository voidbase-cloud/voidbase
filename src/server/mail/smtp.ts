// SMTP client on Cloudflare TCP sockets (tools/mailer/smtp.go semantics): implicit TLS when settings.smtp.tls,
// otherwise opportunistic STARTTLS when the server offers it; AUTH PLAIN (default) or LOGIN; EHLO with localName.
import { connect } from "cloudflare:sockets";

export interface SMTPConfig { host: string; port: number; username: string; password: string; authMethod: string; tls: boolean; localName: string }
export interface Envelope { from: string; to: string[]; data: string }

const TIMEOUT_MS = 30_000;

class Conn {
  private buf = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private dec = new TextDecoder(); private enc = new TextEncoder();
  constructor(private socket: Socket) { this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter(); }
  async startTls(): Promise<Conn> {
    this.reader.releaseLock(); this.writer.releaseLock();
    return new Conn(this.socket.startTls());
  }
  // one SMTP reply, possibly multi-line ("250-..." continuation lines)
  async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.line();
      lines.push(line.slice(4));
      if (line.length >= 4 && line[3] === " ") return { code: Number(line.slice(0, 3)), lines };
      if (line.length < 4) throw new Error(`smtp: malformed reply ${JSON.stringify(line)}`);
    }
  }
  private async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return l; }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("smtp: connection closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async cmd(text: string, expect: number[]): Promise<{ code: number; lines: string[] }> {
    await this.writer.write(this.enc.encode(text + "\r\n"));
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(`smtp: ${text.split(" ")[0]} failed: ${r.code} ${r.lines.join(" ")}`);
    return r;
  }
  async raw(text: string) { await this.writer.write(this.enc.encode(text)); }
  async close() { try { await this.writer.close(); } catch { /* closed */ } try { this.socket.close(); } catch { /* closed */ } }
}

export async function sendSMTP(cfg: SMTPConfig, env: Envelope): Promise<void> {
  const run = async () => {
    const socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.tls ? "on" : "starttls", allowHalfOpen: false });
    let conn = new Conn(socket);
    const name = cfg.localName || "localhost";
    try {
      const greeting = await conn.reply();
      if (greeting.code !== 220) throw new Error(`smtp: unexpected greeting ${greeting.code}`);
      let ehlo = await conn.cmd(`EHLO ${name}`, [250]);
      if (!cfg.tls && ehlo.lines.some((l) => l.toUpperCase().startsWith("STARTTLS"))) {
        await conn.cmd("STARTTLS", [220]);
        conn = await conn.startTls();
        ehlo = await conn.cmd(`EHLO ${name}`, [250]);
      }
      if (cfg.username || cfg.password) {
        if (cfg.authMethod === "LOGIN") {
          await conn.cmd("AUTH LOGIN", [334]);
          await conn.cmd(btoa(cfg.username), [334]);
          await conn.cmd(btoa(cfg.password), [235]);
        } else {
          await conn.cmd(`AUTH PLAIN ${btoa(`\0${cfg.username}\0${cfg.password}`)}`, [235]);
        }
      }
      await conn.cmd(`MAIL FROM:<${env.from}>`, [250]);
      for (const rcpt of env.to) await conn.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
      await conn.cmd("DATA", [354]);
      const stuffed = env.data.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
      await conn.raw(stuffed.endsWith("\r\n") ? stuffed : stuffed + "\r\n");
      await conn.cmd(".", [250]);
      try { await conn.cmd("QUIT", [221]); } catch { /* some servers close right away */ }
    } finally { await conn.close(); }
  };
  await Promise.race([run(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("smtp: timeout")), TIMEOUT_MS))]);
}
