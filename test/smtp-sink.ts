// SMTP sink for tests: accepts any mail on 2525 (EHLO, optional AUTH, MAIL/RCPT/DATA) and exposes the captured
// messages over HTTP on 2526: GET /messages, DELETE /messages.
//   bun test/smtp-sink.ts [smtpPort=2525] [httpPort=2526]
const smtpPort = Number(process.argv[2] ?? 2525), httpPort = Number(process.argv[3] ?? 2526);
interface Captured { from: string; to: string[]; raw: string; subject: string; html: string; text: string; headers: Record<string, string> }
const messages: Captured[] = [];
const decodeB64 = (s: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0))); } catch { return s; } };
const decodeQP = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
function parse(raw: string, from: string, to: string[]): Captured {
  const sep = raw.indexOf("\r\n\r\n"); const head = raw.slice(0, sep).replace(/\r\n[ \t]+/g, " "); const body = raw.slice(sep + 4);
  const headers: Record<string, string> = {}; for (const line of head.split("\r\n")) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const subject = (headers.subject ?? "").replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_m, b) => decodeB64(b));
  const out = { html: "", text: "" };
  // recursive MIME walk: multipart/mixed may wrap multipart/alternative (mailyak), leaves are text/plain or text/html
  const walk = (partHeaders: Record<string, string>, partBody: string) => {
    const ct = (partHeaders["content-type"] ?? "").toLowerCase();
    const m = /boundary="?([^";]+)"?/i.exec(partHeaders["content-type"] ?? "");
    if (ct.startsWith("multipart/") && m) {
      for (const piece of partBody.split(`--${m[1]}`).slice(1)) {
        if (piece.trim() === "--" || !piece.includes("\r\n\r\n")) continue;
        const i = piece.indexOf("\r\n\r\n"); const ph: Record<string, string> = {};
        for (const line of piece.slice(0, i).replace(/\r\n[ \t]+/g, " ").split("\r\n")) { const j = line.indexOf(":"); if (j > 0) ph[line.slice(0, j).toLowerCase().trim()] = line.slice(j + 1).trim(); }
        walk(ph, piece.slice(i + 4));
      }
      return;
    }
    const enc = (partHeaders["content-transfer-encoding"] ?? "").toLowerCase();
    const decoded = enc.includes("base64") ? decodeB64(partBody) : enc.includes("quoted-printable") ? decodeQP(partBody) : partBody;
    if (ct.includes("text/html")) out.html = decoded; else if (ct.includes("text/plain") || !ct) out.text = decoded;
  };
  walk(headers, body);
  return { from: from.split(" ")[0]!, to, raw, subject, html: out.html.trim(), text: out.text.trim(), headers };
}
Bun.listen<{ buf: string; from: string; to: string[]; inData: boolean }>({
  hostname: "127.0.0.1", port: smtpPort,
  socket: {
    open(s) { s.data = { buf: "", from: "", to: [], inData: false }; s.write("220 sink ESMTP\r\n"); },
    data(s, chunk) {
      s.data.buf += chunk.toString();
      for (;;) {
        if (s.data.inData) {
          const end = s.data.buf.indexOf("\r\n.\r\n"); if (end < 0) return;
          const raw = s.data.buf.slice(0, end).replace(/\r\n\.\./g, "\r\n."); s.data.buf = s.data.buf.slice(end + 5); s.data.inData = false;
          messages.push(parse(raw, s.data.from, s.data.to)); s.data.from = ""; s.data.to = []; s.write("250 OK queued\r\n"); continue;
        }
        const i = s.data.buf.indexOf("\r\n"); if (i < 0) return;
        const line = s.data.buf.slice(0, i); s.data.buf = s.data.buf.slice(i + 2); const up = line.toUpperCase();
        if (up.startsWith("EHLO") || up.startsWith("HELO")) s.write("250-sink\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 OK\r\n");
        else if (up.startsWith("AUTH LOGIN")) { s.write("334 VXNlcm5hbWU6\r\n"); s.data.buf = s.data.buf.replace(/^[^\r\n]*\r\n/, (u) => { s.write("334 UGFzc3dvcmQ6\r\n"); void u; return ""; }); }
        else if (up.startsWith("AUTH")) s.write("235 ok\r\n");
        else if (up.startsWith("MAIL FROM:")) { s.data.from = line.slice(10).trim().replace(/[<>]/g, ""); s.write("250 OK\r\n"); }
        else if (up.startsWith("RCPT TO:")) { s.data.to.push(line.slice(8).trim().replace(/[<>]/g, "")); s.write("250 OK\r\n"); }
        else if (up === "DATA") { s.data.inData = true; s.write("354 go\r\n"); }
        else if (up === "QUIT") { s.write("221 bye\r\n"); s.end(); }
        else if (up === "RSET" || up === "NOOP") s.write("250 OK\r\n");
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) s.write("235 ok\r\n"); // AUTH LOGIN credential lines
        else s.write("500 unknown\r\n");
      }
    },
  },
});
Bun.serve({ port: httpPort, hostname: "127.0.0.1", fetch(req) { if (req.method === "DELETE") { messages.length = 0; return new Response(null, { status: 204 }); } return Response.json(messages); } });
console.log(`smtp sink on 127.0.0.1:${smtpPort}, messages at http://127.0.0.1:${httpPort}/messages`);
