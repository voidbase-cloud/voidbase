// The names the deploy and the mail plugin agree on: data, so src/node/deploy-cf.ts can write the binding without
// importing what the plugin does (the kernel, the platform modules).
/** the send_email binding the deploy adds to the Worker when VOIDBASE_MAIL_DOMAIN is set */
export const MAIL_BINDING = "SEND_EMAIL";
/** the sending domain: a var the deploy bakes beside the binding, and the domain the plugin holds the From to */
export const MAIL_DOMAIN_VAR = "VOIDBASE_MAIL_DOMAIN";
