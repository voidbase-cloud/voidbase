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

// ---- update (apis/settings.go settingsSet + core/settings_model.go Validate) -----------------------
export interface FieldErr { code: string; message: string; params?: Record<string, unknown> }
export type NestedErrors = { [k: string]: FieldErr | NestedErrors };

// json.Unmarshal into a clone: nested objects merge field by field, arrays are replaced, unknown keys are dropped,
// omitted secrets keep their stored value
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const walk = (base: unknown, p: unknown): unknown => {
    if (p === undefined) return base;
    if (base !== null && typeof base === "object" && !Array.isArray(base)) {
      if (p === null || typeof p !== "object" || Array.isArray(p)) return base;
      const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
      for (const k of Object.keys(out)) if (k in (p as Record<string, unknown>)) out[k] = walk(out[k], (p as Record<string, unknown>)[k]);
      return out;
    }
    return p;
  };
  return walk(current, patch) as Settings;
}

const required: FieldErr = { code: "validation_required", message: "Cannot be blank." };
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isURL = (v: string) => { try { const u = new URL(v); return !!u.protocol && !!u.host; } catch { return false; } };
const isHost = (v: string) => /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/.test(v) || /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || /^[0-9a-fA-F:]+$/.test(v);
const isHexColor = (v: string) => /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
const isIPOrSubnet = (v: string) => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(v) || /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(v);
export const lengthErr = (min: number, max: number): FieldErr => (min === max ? { code: "validation_length_invalid", message: `The length must be exactly ${min}.`, params: { max, min } } : { code: "validation_length_out_of_range", message: `The length must be between ${min} and ${max}.`, params: { max, min } });
export const minErr = (n: number): FieldErr => ({ code: "validation_min_greater_equal_than_required", message: `Must be no less than ${n}.`, params: { threshold: n } });
export const maxErr = (n: number): FieldErr => ({ code: "validation_max_less_equal_than_required", message: `Must be no greater than ${n}.`, params: { threshold: n } });
const inInvalid: FieldErr = { code: "validation_in_invalid", message: "Must be a valid value." };
const MAX_SAFE = 9007199254740991;

const CRON_MACROS: Record<string, string> = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };
const sentenize = (m: string) => { const t = m.charAt(0).toUpperCase() + m.slice(1); return /[.!?]$/.test(t) ? t : t + "."; };
const atoi = (v: string): number | string => (/^[+-]?\d+$/.test(v) ? Number(v) : `strconv.Atoi: parsing ${JSON.stringify(v)}: invalid syntax`);
// tools/cron/schedule.go NewSchedule + parseCronSegment, same checks in the same order
function cronError(expr: string): string | null {
  const segments = (CRON_MACROS[expr] ?? expr).split(" ");
  if (segments.length !== 5) return sentenize("invalid cron expression - must be a valid macro or to have exactly 5 space separated segments");
  const bounds: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    const [min, max] = bounds[i]!;
    for (const p of segments[i]!.split(",")) {
      const stepParts = p.split("/");
      let step = 1;
      if (stepParts.length === 2) {
        const parsed = atoi(stepParts[1]!); if (typeof parsed === "string") return sentenize(parsed);
        if (parsed < 1 || parsed > max) return sentenize(`invalid segment step boundary - the step must be between 1 and the ${max}`);
        step = parsed;
      } else if (stepParts.length > 2) return sentenize("invalid segment step format - must be in the format */n or 1-30/n");
      if (stepParts[0] !== "*") {
        const rangeParts = stepParts[0]!.split("-");
        if (rangeParts.length === 1) {
          if (step !== 1) return sentenize("invalid segment step - step > 1 could be used only with the wildcard or range format");
          const parsed = atoi(rangeParts[0]!); if (typeof parsed === "string") return sentenize(parsed);
          if (parsed < min || parsed > max) return sentenize("invalid segment value - must be between the min and max of the segment");
        } else if (rangeParts.length === 2) {
          const lo = atoi(rangeParts[0]!); if (typeof lo === "string") return sentenize(lo);
          if (lo < min || lo > max) return sentenize(`invalid segment range minimum - must be between ${min} and ${max}`);
          const hi = atoi(rangeParts[1]!); if (typeof hi === "string") return sentenize(hi);
          if (hi < lo || hi > max) return sentenize(`invalid segment range maximum - must be between ${lo} and ${max}`);
        } else return sentenize("invalid segment range format - the range must have 1 or 2 parts");
      }
    }
  }
  return null;
}
const RATE_LIMIT_LABEL = /^(\w+ \/[\w/-]*|\/[\w/-]*|\w+:\w+|\*:\w+|\w+)$/; // rateLimitRuleLabelRegex

export function validateSettings(s: Settings): NestedErrors {
  const errs: NestedErrors = {};
  const set = (path: string[], e: FieldErr) => { let cur = errs; for (const k of path.slice(0, -1)) cur = (cur[k] ??= {}) as NestedErrors; cur[path[path.length - 1]!] = e; };
  s.superuserIPs.forEach((ip, i) => { if (!ip) set(["superuserIPs", String(i)], required); else if (!isIPOrSubnet(ip)) set(["superuserIPs", String(i)], { code: "validation_invlaid_ip_or_subnet", message: "Invalid IP or CIDR subnet." }); });
  const m = s.meta;
  if (m.accentColor.length !== 7) set(["meta", "accentColor"], lengthErr(7, 7)); else if (!isHexColor(m.accentColor)) set(["meta", "accentColor"], { code: "validation_is_hex_color", message: "Must be a valid hexadecimal color code." });
  if (!m.appName) set(["meta", "appName"], required); else if (m.appName.length > 255) set(["meta", "appName"], lengthErr(1, 255));
  if (!m.appURL) set(["meta", "appURL"], required); else if (!isURL(m.appURL)) set(["meta", "appURL"], { code: "validation_is_url", message: "Must be a valid URL." });
  if (!m.senderName) set(["meta", "senderName"], required); else if (m.senderName.length > 255) set(["meta", "senderName"], lengthErr(1, 255));
  if (!m.senderAddress) set(["meta", "senderAddress"], required); else if (!isEmail(m.senderAddress)) set(["meta", "senderAddress"], { code: "validation_is_email", message: "Must be a valid email address." });
  const l = s.logs as Settings["logs"] & { maxDataSize?: number };
  if ((l.maxDataSize ?? 0) < 0) set(["logs", "maxDataSize"], minErr(0)); else if ((l.maxDataSize ?? 0) > MAX_SAFE) set(["logs", "maxDataSize"], maxErr(MAX_SAFE));
  if (l.maxDays < 0) set(["logs", "maxDays"], minErr(0)); else if (l.maxDays > MAX_SAFE) set(["logs", "maxDays"], maxErr(MAX_SAFE));
  if (l.minLevel > MAX_SAFE) set(["logs", "minLevel"], maxErr(MAX_SAFE));
  const smtp = s.smtp;
  if (smtp.enabled && !smtp.host) set(["smtp", "host"], required); else if (smtp.host && !isHost(smtp.host)) set(["smtp", "host"], { code: "validation_is_host", message: "Must be a valid IP address or DNS name." });
  if (smtp.enabled && !smtp.port) set(["smtp", "port"], required); else if (smtp.port < 0) set(["smtp", "port"], minErr(0));
  if (smtp.authMethod && !["PLAIN", "LOGIN"].includes(smtp.authMethod)) set(["smtp", "authMethod"], inInvalid);
  if (smtp.localName && !isHost(smtp.localName)) set(["smtp", "localName"], { code: "validation_is_host", message: "Must be a valid IP address or DNS name." });
  const s3 = (cfg: Settings["s3"], path: string[]) => {
    if (cfg.endpoint && !isURL(cfg.endpoint)) set([...path, "endpoint"], { code: "validation_is_url", message: "Must be a valid URL." }); else if (cfg.enabled && !cfg.endpoint) set([...path, "endpoint"], required);
    for (const k of ["bucket", "region", "accessKey", "secret"] as const) if (cfg.enabled && !cfg[k]) set([...path, k], required);
  };
  s3(s.s3, ["s3"]); s3(s.backups.s3, ["backups", "s3"]);
  const cronErr = s.backups.cron ? cronError(s.backups.cron) : null;
  if (cronErr) set(["backups", "cron"], { code: "validation_invalid_cron", message: cronErr });
  const b = s.batch;
  if (b.enabled && !b.maxRequests) set(["batch", "maxRequests"], required); else if (b.maxRequests < 0) set(["batch", "maxRequests"], minErr(0));
  if (b.enabled && !b.timeout) set(["batch", "timeout"], required); else if (b.timeout < 0) set(["batch", "timeout"], minErr(0));
  if (b.maxBodySize < 0) set(["batch", "maxBodySize"], minErr(0));
  let rulesValid = true;
  s.rateLimits.rules.forEach((r, i) => {
    const p = ["rateLimits", "rules", String(i)];
    const before = JSON.stringify(errs);
    if (!r.label) set([...p, "label"], required); else if (!RATE_LIMIT_LABEL.test(r.label)) set([...p, "label"], { code: "validation_match_invalid", message: "Must be in a valid format." });
    if (!r.maxRequests) set([...p, "maxRequests"], required); else if (r.maxRequests < 1) set([...p, "maxRequests"], minErr(1));
    if (!r.duration) set([...p, "duration"], required); else if (r.duration < 1) set([...p, "duration"], minErr(1));
    if (r.audience && !["", "@guest", "@auth"].includes(r.audience)) set([...p, "audience"], inInvalid);
    if (JSON.stringify(errs) !== before) rulesValid = false;
  });
  if (rulesValid) { // checkUniqueRuleLabel runs only when every rule validated (ozzo stops at the first failing rule)
    const existing: string[] = [];
    for (const [i, r] of s.rateLimits.rules.entries()) {
      const fullKey = r.label + "@@" + (r.audience ?? "");
      if (existing.some((k) => k.startsWith(fullKey) || fullKey.startsWith(k))) { set(["rateLimits", "rules", String(i), "label"], { code: "validation_conflicting_rate_limit_rule", message: `Rate limit rule configuration with label ${r.label} already exists or conflicts with another rule.`, params: { label: r.label } }); break; }
      existing.push(fullKey);
    }
  }
  s.rateLimits.excludedIPs.forEach((ip, i) => { if (!ip) set(["rateLimits", "excludedIPs", String(i)], required); else if (!isIPOrSubnet(ip)) set(["rateLimits", "excludedIPs", String(i)], { code: "validation_invlaid_ip_or_subnet", message: "Invalid IP or CIDR subnet." }); });
  return sortNested(errs);
}
export function sortNested(e: NestedErrors): NestedErrors {
  return Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, "code" in v && typeof v.code === "string" ? v : sortNested(v as NestedErrors)])) as NestedErrors;
}

export async function saveSettings(db: D1Database, s: Settings): Promise<void> {
  await run(db, "UPDATE `_params` SET value = ?, updated = ? WHERE id = 'settings'", [JSON.stringify(s), nowString()]);
  invalidateSettings();
}
