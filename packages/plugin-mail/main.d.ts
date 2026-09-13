import type { Mail } from "@voidbase-cloud/voidbase/interfaces";
import type { Bindings } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
import { MAIL_BINDING, MAIL_DOMAIN_VAR } from "@voidbase-cloud/voidbase/plugins/mail-binding";
export { MAIL_BINDING, MAIL_DOMAIN_VAR };
/** the sending domain these bindings carry, lowercased, or empty when the deploy named none */
export declare const mailDomain: (env: Bindings) => string;
export declare const cloudflareMail: Mail;
declare const mail: Omit<Plugin, "manifest">;
export default mail;
