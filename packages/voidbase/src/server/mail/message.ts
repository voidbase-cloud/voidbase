// RFC 5322 message construction (what mailyak does for PocketBase): multipart/alternative with a text and an
// HTML part, encoded words for non-ASCII headers, Message-ID from the sender's domain when none is given.
export interface Address { address: string; name?: string }
export interface MailMessage { from: Address; to: Address[]; cc?: Address[]; bcc?: Address[]; subject: string; html: string; text?: string; headers?: Record<string, string> }

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const encodeWord = (s: string) => (isAscii(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
// net/mail Address.String(): the display name is quoted only when it contains something other than atext and spaces
const needsQuote = (s: string) => !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ .-]*$/.test(s);
const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
export const formatAddress = (a: Address) => (a.name ? `${!isAscii(a.name) ? encodeWord(a.name) : needsQuote(a.name) ? quote(a.name) : a.name} <${a.address}>` : a.address);
const base64Lines = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/(.{76})/g, "$1\r\n");
export const randomToken = (n: number) => { const chars = "abcdefghijklmnopqrstuvwxyz0123456789"; let out = ""; const bytes = crypto.getRandomValues(new Uint8Array(n)); for (const b of bytes) out += chars[b % chars.length]; return out; };

export function buildMime(m: MailMessage, text: string): { from: string; rcpts: string[]; data: string } {
  const boundary = `--pb-${randomToken(24)}`;
  const headers: [string, string][] = [
    ["From", formatAddress(m.from)],
    ["To", m.to.map(formatAddress).join(", ")],
  ];
  if (m.cc?.length) headers.push(["Cc", m.cc.map(formatAddress).join(", ")]);
  headers.push(["Subject", encodeWord(m.subject)], ["Date", new Date().toUTCString().replace("GMT", "+0000")], ["MIME-Version", "1.0"]);
  const extra = Object.entries(m.headers ?? {});
  if (!extra.some(([k]) => k.toLowerCase() === "message-id")) {
    const domain = m.from.address.split("@")[1];
    if (domain) headers.push(["Message-ID", `<${randomToken(15)}@${domain}>`]);
  }
  for (const [k, v] of extra) headers.push([k, v]);
  headers.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);
  const part = (type: string, body: string) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}\r\n`;
  const data = headers.map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + part("text/plain", text) + part("text/html", m.html) + `--${boundary}--\r\n`;
  return { from: m.from.address, rcpts: [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((a) => a.address), data };
}

// tools/mailer/html2text.go, simplified: block tags and <br> become CRLF, inline tags vanish, links keep their text
export function htmlToText(html: string): string {
  let s = html.replace(/<head[\s\S]*?<\/head>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\r\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|pre|ul|ol|section|article|header|footer)>/gi, "\r\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== "")).join("\r\n").trim();
}
