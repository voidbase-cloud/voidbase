// Process environment (Bun loads .env files itself)
export const env = process.env as Record<string, string | undefined>;
// a local SQLite file is cheap: log every request like PocketBase does
export const defaultLogMinLevel = 0;
