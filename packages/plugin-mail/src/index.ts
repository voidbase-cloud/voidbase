// Mail from the instance's own domain through Cloudflare's Email Service, as the plugin that provides `mail@1`.
//
// The core builds every message and decides when it goes (src/server/mail/index.ts); this is only the carrier. The
// Worker gets a `send_email` binding named SEND_EMAIL when the deploy is told the sending domain
// (VOIDBASE_MAIL_DOMAIN, src/node/deploy-cf.ts), and a binding arrives with the request and not at load, so the
// provider answers per env the way realtime does: `carrier(env)` names where mail goes with these bindings, or
// null, in which case the core uses what it had (the HTTP provider, the SMTP settings, a log line) and nothing here
// runs. Without the binding the plugin is loaded and idle.
//
// Cloudflare accepts a sender only from a domain onboarded to Email Sending, so the From is held to the one domain
// the deploy named rather than left to fail at the binding with an E_SENDER_NOT_VERIFIED: a message from anywhere
// else is refused with the reason, and the core hands it to SMTP when SMTP is configured.
//
// The message is the RFC 5322 text buildMime writes for SMTP (multipart/alternative with a text and an html part,
// UTF-8, base64 where needed, Message-ID from the sender's domain, Bcc never written into the headers), handed to
// the binding as EmailMessage(from, to, raw) from cloudflare:email once per recipient: to, cc and bcc alike get the
// same bytes, one call each, because the raw form carries one envelope recipient.
//
// The file is the one that sat in `packages/voidbase/src/server/plugins/mail.ts`, with its eight relative imports
// written as the six published names they already resolved to: `#platform/email` and `#platform/env` are
// package-private and become `/platform/email` (its own entry, because `cloudflare:email` exists on workerd alone)
// and `/platform`; `../mail` and `../mail/message` are one entry, `/mail`, published for this plugin in 7.2; and
// `../interfaces`, `../kernel`, `../types` and `./manifest` keep their own names. The eighth needed an entry that
// did not exist: `./mail-binding` is the two names this plugin and `voidbase deploy` have to agree on, and it is
// published as `/plugins/mail-binding` so that the agreement survives the plugin leaving the core.
import { EmailMessage } from "@voidbase-cloud/voidbase/platform/email";
import { env as voidEnv } from "@voidbase-cloud/voidbase/platform";
import type { Mail } from "@voidbase-cloud/voidbase/interfaces";
import { serve, type Kernel } from "@voidbase-cloud/voidbase/kernel";
import { buildMime, mailRoute } from "@voidbase-cloud/voidbase/mail";
import type { Bindings } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";

import { MAIL_BINDING, MAIL_DOMAIN_VAR } from "@voidbase-cloud/voidbase/plugins/mail-binding";
export { MAIL_BINDING, MAIL_DOMAIN_VAR };

/** the sending domain these bindings carry, lowercased, or empty when the deploy named none */
export const mailDomain = (env: Bindings): string =>
  String((env as unknown as Record<string, unknown>)[MAIL_DOMAIN_VAR] ?? (voidEnv as Record<string, unknown>)[MAIL_DOMAIN_VAR] ?? "").trim().toLowerCase();

const domainOf = (address: string) => address.trim().toLowerCase().split("@")[1] ?? "";

export const cloudflareMail: Mail = {
  carrier(env) {
    const domain = mailDomain(env);
    return env.SEND_EMAIL && domain ? `Cloudflare Email Service, from ${domain}` : null;
  },
  refuses(from, env) {
    const domain = mailDomain(env);
    if (domainOf(from) === domain) return null;
    return `mail from ${from} cannot leave through Cloudflare Email Service: this instance sends from ${domain} (${MAIL_DOMAIN_VAR}). Use an address there, or enable SMTP in the settings for other senders`;
  },
  async send(env, m, text) {
    if (!env.SEND_EMAIL) throw new Error(`voidbase: no ${MAIL_BINDING} binding on this Worker`);
    const refused = cloudflareMail.refuses(m.from.address, env);
    if (refused) throw new Error(refused);
    const mime = buildMime(m, text);
    for (const rcpt of mime.rcpts) await env.SEND_EMAIL.send(new EmailMessage(mime.from, rcpt, mime.data));
  },
};

export const mail: Plugin = {
  manifest: {
    name: "mail",
    version: "0.1.0",
    tier: "official",
    voidbase: "*",
    provides: ["mail@1"],
  },
  // where this instance's own mail goes with these bindings: this carrier when it takes the sender, else what the
  // core falls back to. The core owns the transport, and whoever provides mail@1 answers for where it ends up.
  info: (env) => mailRoute(env),
  apply(ctx: Kernel) {
    serve<Mail>(ctx, "mail@1", cloudflareMail);
  },
};
