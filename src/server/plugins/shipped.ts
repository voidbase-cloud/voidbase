// The plugins voidbase ships, by name: data, so the CLI can tell a shipped plugin from an installed one without
// importing what a shipped plugin does. app.ts loads the objects and checks its list is this one.
export const SHIPPED = ["auth", "realtime", "hardening", "backups", "installer", "openapi", "mcp", "seo", "mail"] as const;
export type ShippedName = (typeof SHIPPED)[number];
