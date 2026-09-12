// The mail plugin: the MIME it hands Cloudflare, the domain it holds the sender to, one send per recipient through
// a fake SEND_EMAIL binding, and the core's fallback to SMTP (or the log line) when the binding is absent or the
// sender is not on the domain.
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Mail } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import { deliverMail, provideMailLookup, routeMail } from "../../src/server/mail";
import { buildMime, type MailMessage } from "../../src/server/mail/message";
import { cloudflareMail, mail, mailDomain, MAIL_BINDING } from "../../src/server/plugins/mail";
import { invalidateSettings } from "../../src/server/settings";
import type { Bindings } from "../../src/server/types";

type Sent = { from: string; to: string; raw: string };
const fakeBinding = () => { const sent: Sent[] = []; return { sent, send: async (m: EmailMessage) => { sent.push({ from: m.from, to: m.to, raw: String((m as unknown as { raw: string }).raw) }); } }; };
// a D1 whose only answer is the settings row, with SMTP as asked
const fakeDb = (smtp: { enabled: boolean; host?: string }) => { const row = { value: JSON.stringify({ smtp: { enabled: smtp.enabled, host: smtp.host ?? "" } }) }; const s = { bind: () => s, first: async () => row, all: async () => ({ results: [row] }), run: async () => ({}) }; return { prepare: () => s } as unknown as D1Database; };
const envWith = (o: { binding?: ReturnType<typeof fakeBinding>; domain?: string; db?: D1Database } = {}): Bindings =>
  ({ DB: o.db ?? ({} as D1Database), STORAGE: {} as R2Bucket, ...(o.binding ? { SEND_EMAIL: o.binding } : {}), ...(o.domain === undefined ? { VOIDBASE_MAIL_DOMAIN: "example.com" } : o.domain ? { VOIDBASE_MAIL_DOMAIN: o.domain } : {}) }) as Bindings;

const message: MailMessage = {
  from: { name: "Shop", address: "noreply@example.com" },
  to: [{ address: "ada@b.test", name: "Ada" }],
  cc: [{ address: "cc@b.test" }],
  bcc: [{ address: "hidden@b.test" }],
  subject: "Willkommen bei Café ✓",
  html: "<p>Grüße from <b>voidbase</b></p>",
};
const text = "Grüße from voidbase";
const decode64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\r?\n/g, "")), (c) => c.charCodeAt(0)));
const header = (raw: string, name: string) => raw.split("\r\n\r\n")[0]!.split("\r\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);

describe("the MIME message the binding gets", () => {
  const mime = buildMime(message, text);
  const head = mime.data.split("\r\n\r\n")[0]!;

  test("the headers: From, To, Cc, Subject, Date, Message-ID, MIME-Version, and never Bcc", () => {
    expect(header(mime.data, "From")).toBe("Shop <noreply@example.com>");
    expect(header(mime.data, "To")).toBe("Ada <ada@b.test>");
    expect(header(mime.data, "Cc")).toBe("cc@b.test");
    expect(head).not.toContain("Bcc");
    expect(mime.data).not.toContain("hidden@b.test");
    expect(header(mime.data, "Date")).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    expect(header(mime.data, "Message-ID")).toMatch(/^<[a-z0-9]{15}@example\.com>$/);
    expect(header(mime.data, "MIME-Version")).toBe("1.0");
    expect(header(mime.data, "Content-Type")).toMatch(/^multipart\/alternative; boundary="--pb-[a-z0-9]{24}"$/);
  });

  test("a non-ASCII subject is an encoded word that decodes back", () => {
    const subject = header(mime.data, "Subject")!;
    expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decode64(subject.slice(10, -2))).toBe("Willkommen bei Café ✓");
  });

  test("two alternative parts, text then html, UTF-8 in base64, closed by the boundary", () => {
    const boundary = header(mime.data, "Content-Type")!.match(/boundary="(.+)"/)![1]!;
    const parts = mime.data.split(`--${boundary}`);
    expect(parts).toHaveLength(4); // headers, text, html, the closing marker
    expect(parts[1]).toContain("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    expect(parts[2]).toContain("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    expect(decode64(parts[1]!.split("\r\n\r\n")[1]!)).toBe(text);
    expect(decode64(parts[2]!.split("\r\n\r\n")[1]!)).toBe(message.html);
    expect(parts[3]).toBe("--\r\n");
  });

  test("the envelope: the bare sender, every recipient including bcc", () => {
    expect(mime.from).toBe("noreply@example.com");
    expect(mime.rcpts).toEqual(["ada@b.test", "cc@b.test", "hidden@b.test"]);
  });
});

describe("the domain the sender is held to", () => {
  test("the domain comes from the Worker's var, lowercased", () => {
    expect(mailDomain(envWith({ domain: " Example.COM " }))).toBe("example.com");
    expect(mailDomain(envWith({ domain: "" }))).toBe("");
  });

  test("a sender on the domain passes, whatever its case; one elsewhere is refused with the reason", () => {
    const env = envWith();
    expect(cloudflareMail.refuses("noreply@example.com", env)).toBeNull();
    expect(cloudflareMail.refuses("NoReply@Example.COM", env)).toBeNull();
    const why = cloudflareMail.refuses("hello@other.org", env);
    expect(why).toContain("hello@other.org");
    expect(why).toContain("example.com");
    expect(why).toContain("VOIDBASE_MAIL_DOMAIN");
    expect(why).toContain("SMTP");
    expect(cloudflareMail.refuses("noreply@mail.example.com", env)).not.toBeNull(); // a subdomain is onboarded on its own
  });

  test("the carrier exists only with the binding and the domain together", () => {
    expect(cloudflareMail.carrier(envWith())).toBeNull();
    expect(cloudflareMail.carrier(envWith({ binding: fakeBinding(), domain: "" }))).toBeNull();
    expect(cloudflareMail.carrier(envWith({ binding: fakeBinding() }))).toBe("Cloudflare Email Service, from example.com");
  });
});

describe("sending through the binding", () => {
  test("one EmailMessage per recipient, to, cc and bcc alike, with the same raw message", async () => {
    const binding = fakeBinding();
    await cloudflareMail.send(envWith({ binding }), message, text);
    expect(binding.sent.map((s) => s.to)).toEqual(["ada@b.test", "cc@b.test", "hidden@b.test"]);
    expect(binding.sent.every((s) => s.from === "noreply@example.com")).toBe(true);
    expect(new Set(binding.sent.map((s) => s.raw)).size).toBe(1);
    expect(header(binding.sent[0]!.raw, "To")).toBe("Ada <ada@b.test>");
    expect(binding.sent[0]!.raw).not.toContain("hidden@b.test");
  });

  test("a sender off the domain never reaches the binding", async () => {
    const binding = fakeBinding();
    await expect(cloudflareMail.send(envWith({ binding }), { ...message, from: { address: "hello@other.org" } }, text)).rejects.toThrow(/hello@other\.org cannot leave through Cloudflare Email Service/);
    expect(binding.sent).toHaveLength(0);
  });

  test("without the binding the plugin refuses to pretend", async () => {
    await expect(cloudflareMail.send(envWith(), message, text)).rejects.toThrow(new RegExp(`no ${MAIL_BINDING} binding`));
  });

  test("the plugin provides mail@1 through the kernel", async () => {
    const kernel = createKernel(new Hono() as never);
    const loaded = await load(kernel, [mail], "0.9.0");
    expect(loaded.providers["mail@1"]).toBe("mail");
    expect(loaded.tiers.mail).toBe("official");
    expect(using<Mail>(kernel, "mail@1")).toBe(cloudflareMail);
  });
});

describe("the core's transport with the provider in place", () => {
  afterEach(() => { provideMailLookup(() => undefined); invalidateSettings(); });

  test("routeMail: the binding carries mail from the domain; without it, SMTP when enabled, else the log", () => {
    provideMailLookup(() => cloudflareMail);
    const smtpOn = { enabled: true, host: "smtp.test" }, smtpOff = { enabled: false, host: "" };
    expect(routeMail(envWith({ binding: fakeBinding() }), "noreply@example.com", smtpOff)).toEqual({ via: "plugin", carrier: "Cloudflare Email Service, from example.com" });
    expect(routeMail(envWith(), "noreply@example.com", smtpOn)).toEqual({ via: "smtp", host: "smtp.test" });
    expect(routeMail(envWith(), "noreply@example.com", smtpOff)).toEqual({ via: "log" });
  });

  test("routeMail: a sender off the domain goes to SMTP when it is configured, else nowhere, with the reason", () => {
    provideMailLookup(() => cloudflareMail);
    expect(routeMail(envWith({ binding: fakeBinding() }), "hello@other.org", { enabled: true, host: "smtp.test" })).toEqual({ via: "smtp", host: "smtp.test" });
    const r = routeMail(envWith({ binding: fakeBinding() }), "hello@other.org", { enabled: false, host: "" });
    expect(r.via).toBe("log");
    expect((r as { refused?: string }).refused).toContain("hello@other.org");
  });

  test("deliverMail without the binding: the SMTP path exactly as before (here: disabled, so the log line)", async () => {
    provideMailLookup(() => cloudflareMail);
    const lines: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { await deliverMail(envWith({ db: fakeDb({ enabled: false }) }), message, text); } finally { console.log = orig; }
    expect(lines.join("\n")).toContain('mail not delivered (SMTP disabled): "Willkommen bei Café ✓" -> ada@b.test');
  });

  test("deliverMail with the binding: the plugin sends, and the settings are never read", async () => {
    provideMailLookup(() => cloudflareMail);
    const binding = fakeBinding();
    await deliverMail(envWith({ binding }), message, text); // DB is {} here: reading it would throw
    expect(binding.sent).toHaveLength(3);
  });

  test("deliverMail with the binding and a sender off the domain: refused with the reason when SMTP is disabled", async () => {
    provideMailLookup(() => cloudflareMail);
    const binding = fakeBinding();
    await expect(deliverMail(envWith({ binding, db: fakeDb({ enabled: false }) }), { ...message, from: { address: "hello@other.org" } }, text)).rejects.toThrow(/hello@other\.org cannot leave through Cloudflare Email Service.*SMTP is disabled, so the message was not sent/);
    expect(binding.sent).toHaveLength(0);
  });
});
