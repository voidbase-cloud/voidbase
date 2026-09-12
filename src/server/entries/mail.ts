// `@voidbase-cloud/voidbase/mail`: the two things the mail plugin needs from the core's mail.
//
// `buildMime` is the RFC 5322 text a message becomes before the SMTP transport or the `send_email` binding takes
// it; `mailRoute` is the answer to "where would a message go from here", which the plugin returns from its own
// `info(env)` and `GET /api/plugins` reports. Sending itself is not here: `sendMail` and the record flows around it
// are the core's, called by routes that are not the plugin's, and the plugin provides the carrier through `mail@1`
// rather than calling them.
export { mailRoute, type MailRoute } from "../mail";
export { buildMime, htmlToText, type Address, type MailMessage } from "../mail/message";
