import { one, run } from "./db";
import { nowString } from "./ids";

// Defaults mirror PocketBase core/settings_model.go (captured from a 0.40.2 instance).
// Stored as JSON in _params under id "settings". Secrets are stored but never returned by GET.
export function defaultSettings() {
  return {
    superuserIPs: [] as string[],
    smtp: { enabled: false, port: 587, host: "smtp.example.com", username: "", password: "", authMethod: "", tls: false, localName: "" },
    backups: { cron: "", cronMaxKeep: 3, s3: { enabled: false, bucket: "", region: "", endpoint: "", accessKey: "", secret: "", forcePathStyle: false } },
    s3: { enabled: false, bucket: "", region: "", endpoint: "", accessKey: "", secret: "", forcePathStyle: false },
    meta: { accentColor: "#1055c9", appName: "Acme", appURL: "http://localhost:8090", senderName: "Support", senderAddress: "support@example.com", hideControls: false },
    rateLimits: {
      rules: [
        { label: "*:auth", audience: "", duration: 3, maxRequests: 2 },
        { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
        { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
        { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
      ],
      excludedIPs: [] as string[],
      enabled: false,
    },
    trustedProxy: { headers: [] as string[], useLeftmostIP: false },
    batch: { enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 },
    logs: { maxDays: 5, minLevel: 0, logIP: true, logAuthId: false },
  };
}

export type Settings = ReturnType<typeof defaultSettings>;

// The public shape: same as stored minus smtp.password, s3.secret, backups.s3.secret.
export function publicSettings(s: Settings) {
  const { password: _p, ...smtp } = s.smtp;
  const { secret: _s, ...s3 } = s.s3;
  const { secret: _b, ...backupsS3 } = s.backups.s3;
  return { ...s, smtp, backups: { ...s.backups, s3: backupsS3 }, s3 };
}

let cached: { value: Settings; at: number } | null = null;
const TTL = 5_000;

export function invalidateSettings() {
  cached = null;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  const row = await one<{ value: string }>(db, "SELECT value FROM `_params` WHERE id = 'settings'");
  const value = row?.value ? deepMerge(defaultSettings(), JSON.parse(row.value)) : defaultSettings();
  cached = { value, at: Date.now() };
  return value;
}

export async function ensureSettingsRow(db: D1Database): Promise<void> {
  const row = await one(db, "SELECT id FROM `_params` WHERE id = 'settings'");
  if (row) return;
  const now = nowString();
  await run(db, "INSERT OR IGNORE INTO `_params` (id, value, created, updated) VALUES ('settings', ?, ?, ?)", [
    JSON.stringify(defaultSettings()), now, now,
  ]);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = cur !== null && typeof cur === "object" && !Array.isArray(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}
