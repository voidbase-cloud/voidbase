# @voidbase-cloud/plugin-mail

The mail plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It provides
`mail@1`: the instance's own mail through Cloudflare's Email Service, from the one domain the deploy was told about.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

- **It is the carrier, not the mail.** The core builds every message and decides when it goes; this plugin says
  where it can leave from. A `send_email` binding arrives with the request and not at load, so the provider answers
  per env: `carrier(env)` names where mail goes with these bindings, or `null`, and then the core uses what it had
  (the HTTP provider, the SMTP settings, a log line). Without the binding the plugin is loaded and idle.
- **The From is held to the deploy's domain.** Cloudflare accepts a sender only from a domain onboarded to Email
  Sending, so a message from anywhere else is refused here with the reason rather than failing at the binding with
  an `E_SENDER_NOT_VERIFIED`; the core hands it to SMTP when SMTP is configured.
- **It needed one new published entry**, `@voidbase-cloud/voidbase/plugins/mail-binding`. `SEND_EMAIL` and
  `VOIDBASE_MAIL_DOMAIN` are the two names this plugin and `voidbase deploy` have to agree on, and they are data in
  a module of their own precisely so the deploy can write the binding without importing what the plugin does. That
  was a sibling import while both lived in the core; from a package it has to be a name, or the agreement is two
  copies of two strings.
- **Everything else it imports was already published**: `/platform/email` (an entry of its own, because
  `cloudflare:email` exists on workerd alone), `/platform`, `/mail` (`mailRoute` and `buildMime`, published for this
  plugin in 7.2), `/interfaces`, `/kernel`, `/types` and `/plugins`.
- **`@voidbase-cloud/voidbase/plugins/mail` stays published forever**, as a re-export of this package.

The rest of the shape — the lockstep version, the peer edge back on the core, `hono` declared at the core's own
range, npm as the only registry this name is published to — is the template `packages/plugin-realtime/README.md`
describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every
`@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
