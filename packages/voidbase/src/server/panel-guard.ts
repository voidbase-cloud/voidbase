// The guarded front door of the admin panel: `voidbaseAdapter({ panel: { path, guard: "superuser" } })`.
//
// On Cloudflare the asset layer answers every path outside `/api` without ever invoking the Worker, so a check on
// the panel's path can only run if something sends that path to `/api`. The adapter writes `_redirects` rules for
// exactly that (src/server/panel-paths.ts `panelRedirectLines`), the same mechanism the seo plugin uses for
// /robots.txt, and they land here. On Bun the app runs before the static fallback, so app.ts mounts this handler
// on the panel's path as well and the two runtimes answer a browser the same way.
//
// **404, never 403.** Someone who is not a superuser is told the path does not exist, because the point of moving
// the panel is that an unauthorised person should not learn it is there.
//
// **What this covers.** The panel's index -- the document that boots it -- and nothing else. The hashed chunks
// under the panel's path are served by the asset layer, so they stay readable to anyone who knows their exact
// URLs; they are PocketBase's stock build and hold no instance data, and every call the panel makes is authorised
// by the API's own rules. docs/adapter.md says so in the same words.
import type { Context } from "hono";
import { findAuthRecordByToken, isSuperuser } from "./auth";
import { cookieValue } from "./csrf";
import { notFound } from "./errors";
import { PANEL_API, PANEL_ENTRY_FILE } from "./panel-paths";
import type { AppEnv } from "./types";

export { PANEL_API, PANEL_DEFAULT_PATH, normalizePanelPath, panelRedirectLines } from "./panel-paths";

/** the cookie the PocketBase SDK writes with `authStore.exportToCookie()`: a browser navigation carries no header */
export const PANEL_COOKIE = "pb_auth";

/**
 * The auth token a request for the panel carries. A browser navigating to a URL sends no `Authorization` header,
 * so the cookie the SDK exports is read too, and `?token=` is accepted for a client that has neither.
 */
export function panelToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  if (header) return /^bearer /i.test(header) ? header.slice(7) : header;
  const raw = cookieValue(req.headers.get("cookie") ?? "", PANEL_COOKIE);
  if (raw) {
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* not encoded */ }
    try {
      const parsed = JSON.parse(value) as { token?: unknown };
      if (parsed && typeof parsed.token === "string") return parsed.token;
    } catch { /* a bare token, not the SDK's JSON */ }
    return value;
  }
  try { return new URL(req.url).searchParams.get("token") ?? ""; } catch { return ""; }
}

/** whether this request carries a voidbase superuser session, by any of the three ways above */
export async function panelSuperuser(c: Context<AppEnv>): Promise<boolean> {
  const token = panelToken(c.req.raw);
  if (!token) return false;
  try { return isSuperuser(await findAuthRecordByToken(c.env.DB, token)); } catch { return false; }
}

/**
 * `at` as a directory of this origin, or "". The value comes from a `_redirects` rule the build wrote, but a
 * request can name anything, so it is checked rather than trusted: one leading slash, a trailing slash, no scheme,
 * no host, no `..`. It grants nothing on its own -- the superuser check runs first, and a superuser may read the
 * static files anyway -- but an unchecked value here would be an open redirect the day this answers with one.
 */
export function panelDirectory(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  if (!value.endsWith("/") || value.includes("..") || value.includes("\\") || /[?#]/.test(value)) return "";
  if (value.startsWith("/api/")) return "";
  return value;
}

interface AssetFetcher { fetch(req: Request): Promise<Response> }

/** the `<base>` the panel's index needs when it is served from /api/panel: its asset URLs are relative to it */
export function withBase(html: string, dir: string): string {
  if (/<base\s/i.test(html)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  const tag = `<base href="${dir.replace(/"/g, "&quot;")}">`;
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}

/**
 * `GET /api/panel`: the panel's index for a superuser, a 404 for anyone else, and a 404 when no directory is named
 * at all -- which is where `hide` sends the old `/_/`, so it answers 404 for everybody.
 */
export async function panelEntry(c: Context<AppEnv>, at = ""): Promise<Response> {
  const miss = () => c.json(notFound().toJSON(), 404);
  // `at` names the directory the panel's files are in. On Cloudflare it arrives in the query, because the rule the
  // build wrote is the only thing that knows it; on Bun the route is mounted on the path itself and passes it in.
  const dir = panelDirectory(c.req.query("at") || at);
  if (!dir) return miss();
  if (!(await panelSuperuser(c))) return miss();
  const assets = (c.env as unknown as { ASSETS?: AssetFetcher }).ASSETS;
  if (!assets || typeof assets.fetch !== "function") return miss();
  // `entry.html` under a guard, `index.html` otherwise (panel-paths.ts says why): a rule applies to this fetch too,
  // so the guarded entry has a name no rule names. An older build that has only index.html still answers.
  let res: Response | null = null;
  for (const file of [PANEL_ENTRY_FILE, "index.html"]) {
    try { const r = await assets.fetch(new Request(new URL(`${dir}${file}`, c.req.url), { method: "GET", headers: { accept: "text/html" } })); if (r.ok) { res = r; break; } }
    catch { /* the next name, then miss() */ }
  }
  if (!res) return miss();
  const html = withBase(await res.text(), dir);
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" } });
}

/** the panel path this runtime was started with, or "" (`voidbase serve` sets it from the generated main.ts) */
export function panelPathFromEnv(env: Record<string, string | undefined> | undefined = safeEnv()): string {
  return String(env?.VOIDBASE_PANEL_PATH ?? "").trim();
}
/** `VOIDBASE_PANEL_GUARD=superuser`: whether the path above is behind the check on this runtime */
export function panelGuardFromEnv(env: Record<string, string | undefined> | undefined = safeEnv()): boolean {
  return String(env?.VOIDBASE_PANEL_GUARD ?? "").trim().toLowerCase() === "superuser";
}
function safeEnv(): Record<string, string | undefined> | undefined {
  try { return process.env as Record<string, string | undefined>; } catch { return undefined; }
}

/** the paths app.ts mounts the entry on beside `/api/panel`, so Bun answers a browser the way Cloudflare does */
export const panelEntryPaths = (path: string): string[] => (path ? [path.slice(0, -1), path, `${path}index.html`] : []);
