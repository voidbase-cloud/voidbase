// `voidbase check --security <url>`: what a running instance actually sends back, read from outside it.
//
// The scope is deliberately the hardening plugin's own surface (src/server/response-policy.ts, src/server/csrf.ts,
// src/server/hardening.ts) rather than a general web scanner. Everything reported here is something a knob turns
// on, so every line can say what to set, and a line nobody can act on has no business being printed.
//
// It reads and never writes: GET, HEAD and OPTIONS only, no credentials, no sign-in, and the one burst it sends is
// twenty requests to a route that costs nothing, which is a spot check for a rate limit rather than a load test.
// Anything that would look like an attack from the instance's own logs is out of scope by construction.
import { normalizeUrl } from "./migrate";

export type Verdict = "pass" | "warn" | "fail";
export interface CheckLine {
  /** the knob-shaped name of what was measured; stable, so a pipeline may grep for one */
  name: string;
  verdict: Verdict;
  /** what the instance answered */
  detail: string;
  /** one sentence: what to set to fix it, or why nothing needs setting */
  fix: string;
}
export interface SecurityReport {
  url: string;
  https: boolean;
  lines: CheckLine[];
  pass: number;
  warn: number;
  fail: number;
}
export interface SecurityCheckOptions {
  url: string;
  /** a path to a real served file, so the files' Content-Security-Policy can be seen (nothing else reveals it) */
  file?: string;
  /** how many requests the rate-limit spot check sends (default 20, never more than 50) */
  burst?: number;
  /** the fetch to use, so a test may hand in its own */
  fetch?: typeof fetch;
}

/** an origin no instance has on its list, which is how the CORS answer is told apart from an echo */
const PROBE_ORIGIN = "https://voidbase-security-check.invalid";
const CHEAP_PATH = "/api/health";
const DEFAULT_BURST = 20;

const has = (h: Headers, name: string) => (h.get(name) ?? "").trim();

/** the whole report, from a handful of reads */
export async function securityCheck(o: SecurityCheckOptions): Promise<SecurityReport> {
  const url = normalizeUrl(o.url);
  const https = new URL(url).protocol === "https:";
  const call = o.fetch ?? fetch;
  const lines: CheckLine[] = [];
  const add = (name: string, verdict: Verdict, detail: string, fix: string) => lines.push({ name, verdict, detail, fix });

  // one ordinary response, asked for from an origin nothing can have listed: the headers, the CORS answer, cookies
  const plain = await call(`${url}${CHEAP_PATH}`, { method: "GET", headers: { origin: PROBE_ORIGIN, accept: "application/json" } });
  const h = plain.headers;

  // --- the headers the policy sets ------------------------------------------------------------------------------
  const nosniff = has(h, "X-Content-Type-Options").toLowerCase();
  add("x-content-type-options", nosniff === "nosniff" ? "pass" : "fail",
    nosniff ? `X-Content-Type-Options: ${nosniff}` : "no X-Content-Type-Options",
    nosniff === "nosniff" ? "nothing to set: the hardening plugin sends it on every response." : "the hardening plugin sends nosniff on every response; this instance is not running it, or something downstream strips it.");

  const frame = has(h, "X-Frame-Options"), coop = has(h, "Cross-Origin-Opener-Policy");
  add("frame-options", frame && coop ? "pass" : "warn",
    `X-Frame-Options: ${frame || "absent"}, Cross-Origin-Opener-Policy: ${coop || "absent"}`,
    frame && coop ? "nothing to set: both come with the plugin." : "both come with the hardening plugin; run it, or set them in whatever sits in front.");

  const hsts = has(h, "Strict-Transport-Security");
  if (!https) add("hsts", "warn", "the instance was reached over http, so HSTS cannot apply", "put the instance behind https; VOIDBASE_HSTS=1 then sends Strict-Transport-Security for a year.");
  else if (!hsts) add("hsts", "warn", "no Strict-Transport-Security on an https instance", "set VOIDBASE_HSTS=1 for a year, or a number of seconds.");
  else add("hsts", "pass", `Strict-Transport-Security: ${hsts}`, "nothing to set.");

  const referrer = has(h, "Referrer-Policy");
  add("referrer-policy", referrer ? "pass" : "warn", referrer ? `Referrer-Policy: ${referrer}` : "no Referrer-Policy",
    referrer ? "nothing to set." : "set VOIDBASE_REFERRER_POLICY, for example strict-origin-when-cross-origin.");

  const permissions = has(h, "Permissions-Policy");
  add("permissions-policy", permissions ? "pass" : "warn", permissions ? `Permissions-Policy: ${permissions}` : "no Permissions-Policy",
    permissions ? "nothing to set." : "set VOIDBASE_PERMISSIONS_POLICY, for example \"camera=(), geolocation=(), microphone=()\".");

  const coep = has(h, "Cross-Origin-Embedder-Policy"), corp = has(h, "Cross-Origin-Resource-Policy");
  const trio = !!(coop && coep && corp);
  add("cross-origin", trio ? "pass" : "warn",
    `opener: ${coop || "absent"}, embedder: ${coep || "absent"}, resource: ${corp || "absent"}`,
    trio ? "nothing to set: all three are sent." : "set VOIDBASE_CROSS_ORIGIN=1 to add the embedder and resource policies beside the opener one.");

  // --- the Content-Security-Policy, on an ordinary response and on a served file ---------------------------------
  const csp = has(h, "Content-Security-Policy");
  add("csp", csp ? "pass" : "warn", csp ? `Content-Security-Policy: ${csp}` : `no Content-Security-Policy on ${CHEAP_PATH}`,
    csp ? "nothing to set: a policy is sent." : "set VOIDBASE_CSP for every response, or VOIDBASE_CSP_ROUTES for the paths that need their own.");

  if (o.file) {
    const filePath = o.file.startsWith("/") ? o.file : `/${o.file}`;
    const fileRes = await call(`${url}${filePath}`, { method: "GET" });
    const fileCsp = has(fileRes.headers, "Content-Security-Policy");
    const strict = /(^|;)\s*default-src\s+'none'/i.test(fileCsp);
    add("csp-files", strict ? "pass" : "fail",
      fileCsp ? `${filePath} answered ${fileRes.status} with Content-Security-Policy: ${fileCsp}` : `${filePath} answered ${fileRes.status} with no Content-Security-Policy`,
      strict ? "nothing to set: a served file cannot run or load anything." : "a served file must carry default-src 'none'; leave VOIDBASE_CSP_FILES unset for the strict default, and check VOIDBASE_CSP_ROUTES is not overriding it for this path.");
  } else {
    add("csp-files", "warn", "no file URL was given, and a files' policy is only visible on a real served file",
      "rerun with --file /api/files/<collection>/<id>/<name> to see it; unset, VOIDBASE_CSP_FILES is the strict default-src 'none' policy.");
  }

  // --- CORS: who may read an answer, and whether credentials ride along -----------------------------------------
  const allowOrigin = has(h, "Access-Control-Allow-Origin");
  const preflight = await call(`${url}${CHEAP_PATH}`, { method: "OPTIONS", headers: { origin: PROBE_ORIGIN, "access-control-request-method": "POST" } });
  const allowCreds = (has(h, "Access-Control-Allow-Credentials") || has(preflight.headers, "Access-Control-Allow-Credentials")).toLowerCase() === "true";
  const open = allowOrigin === "*" || allowOrigin.toLowerCase() === PROBE_ORIGIN;
  if (open && allowCreds) add("cors", "fail", `Access-Control-Allow-Origin: ${allowOrigin} together with Access-Control-Allow-Credentials: true`,
    "any site can read authenticated answers: name the origins in VOIDBASE_CORS_ORIGINS, or stop allowing credentials.");
  else if (open) add("cors", "warn", `Access-Control-Allow-Origin: ${allowOrigin} (any origin may read an answer)`,
    "safe while authentication is a bearer token; name the origins in VOIDBASE_CORS_ORIGINS before any cookie-based auth.");
  else add("cors", "pass", allowOrigin ? `an unlisted origin got Access-Control-Allow-Origin: ${allowOrigin}` : "an unlisted origin got no CORS headers",
    "nothing to set: VOIDBASE_CORS_ORIGINS names the origins.");

  // --- cookies: whatever this instance set while being read -----------------------------------------------------
  const cookies = [...collectCookies(plain), ...collectCookies(preflight)];
  const csrfRes = await call(`${url}/api/csrf`, { method: "GET", headers: { accept: "application/json" } });
  cookies.push(...collectCookies(csrfRes));
  if (!cookies.length) add("cookies", "pass", "nothing this instance answered set a cookie", "nothing to set.");
  else {
    const weak = cookies.filter((c) => !cookieOk(c, https));
    add("cookies", weak.length ? "fail" : "pass",
      cookies.map(cookieSummary).join("; "),
      weak.length ? `${weak.map((c) => c.name).join(", ")} lacks Secure, HttpOnly or SameSite: a session cookie needs all three, and the CSRF token cookie needs Secure and SameSite (it is readable on purpose).` : "nothing to set: every cookie carries what it should.");
  }

  // --- the rate limit, as a spot check --------------------------------------------------------------------------
  const burst = Math.min(50, Math.max(1, Math.floor(o.burst ?? DEFAULT_BURST)));
  let limited = 0, sent = 0;
  for (let i = 0; i < burst; i++) {
    const r = await call(`${url}${CHEAP_PATH}`, { method: "GET" });
    sent++;
    if (r.status === 429) { limited++; break; }
  }
  add("rate-limit", limited ? "pass" : "warn",
    limited ? `a 429 came back after ${sent} request(s)` : `${sent} requests to ${CHEAP_PATH}, no 429`,
    limited ? "nothing to set: a limit answered." : `a spot check of ${burst} requests, not proof: turn rate limits on in Settings > Rate limits, and add the deploy's own ceiling with voidbase deploy --rate-limit 300/10.`);

  // --- what /api/health says about the instance -----------------------------------------------------------------
  const body = await plain.text().catch(() => "");
  const leaks = [
    ...(/\d+\.\d+\.\d+/.test(body) ? ["a version-shaped string in the body"] : []),
    ...(has(h, "X-Powered-By") ? [`X-Powered-By: ${has(h, "X-Powered-By")}`] : []),
    ...(has(h, "Server") ? [`Server: ${has(h, "Server")}`] : []),
  ];
  add("health", leaks.length ? "warn" : "pass",
    leaks.length ? `${CHEAP_PATH} to nobody in particular exposes ${leaks.join(", ")}` : `${CHEAP_PATH} answered ${plain.status} with no version detail`,
    leaks.length ? "an unauthenticated health answer should carry no build detail; strip it in whatever sits in front, since voidbase itself answers the detail to superusers only." : "nothing to set: the detail is a superuser's only.");

  // --- the CSRF rule --------------------------------------------------------------------------------------------
  const doubleSubmit = csrfRes.ok && /"token"\s*:/.test(await csrfRes.clone().text().catch(() => ""));
  const named = !open;
  if (doubleSubmit) add("csrf", "pass", "GET /api/csrf answers a token, so VOIDBASE_CSRF=double-submit is on", "nothing to set: send the token back in X-CSRF-Token on a cookie-authenticated write.");
  else if (named) add("csrf", "warn", "the origin rule is on (VOIDBASE_CORS_ORIGINS names origins) and the double-submit token is off",
    "set VOIDBASE_CSRF=double-submit to require X-CSRF-Token as well; a bearer client is never subject to either.");
  else add("csrf", "warn", "neither CSRF rule is on: the origin list is a wildcard and GET /api/csrf is not answering",
    "safe while authentication is a bearer token; set VOIDBASE_CORS_ORIGINS and VOIDBASE_CSRF=double-submit before any cookie-based auth.");

  return { url, https, lines, pass: count(lines, "pass"), warn: count(lines, "warn"), fail: count(lines, "fail") };
}

const count = (lines: CheckLine[], v: Verdict) => lines.filter((l) => l.verdict === v).length;

interface Cookie { name: string; attrs: string }
function collectCookies(res: Response): Cookie[] {
  const raw = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  return raw.map((line) => ({ name: line.split("=")[0]!.trim(), attrs: line })).filter((c) => !!c.name);
}
const flag = (c: Cookie, name: string) => new RegExp(`;\\s*${name}(\\s*;|\\s*=|\\s*$)`, "i").test(c.attrs);
/** a csrf token cookie is readable on purpose, so HttpOnly is not asked of it; everything else needs all three */
function cookieOk(c: Cookie, https: boolean): boolean {
  const sameSite = flag(c, "SameSite");
  const secure = !https || flag(c, "Secure");
  const httpOnly = /vb_csrf$/.test(c.name) || flag(c, "HttpOnly");
  return sameSite && secure && httpOnly;
}
const cookieSummary = (c: Cookie) =>
  `${c.name} (${[flag(c, "Secure") ? "Secure" : "", flag(c, "HttpOnly") ? "HttpOnly" : "", flag(c, "SameSite") ? "SameSite" : ""].filter(Boolean).join(", ") || "no attributes"})`;

/** the report as lines, the shape the command prints */
export function formatReport(r: SecurityReport): string {
  const w = Math.max(...r.lines.map((l) => l.name.length));
  const out = [`voidbase check --security ${r.url}`, ""];
  for (const l of r.lines) out.push(`${l.verdict.padEnd(4)}  ${l.name.padEnd(w)}  ${l.detail}${l.verdict === "pass" ? "" : `\n      ${" ".repeat(w)}  ${l.fix}`}`);
  out.push("", `${r.pass} pass, ${r.warn} warn, ${r.fail} fail. The rate-limit line is a spot check, not proof: it sends a small burst to one cheap route and looks for a 429.`);
  return out.join("\n");
}
