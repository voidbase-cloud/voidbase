// Where the admin panel is served from, shared between the adapter (src/adapter/panel.ts, which writes the files
// and the `_redirects` rules at build time) and the Worker (src/server/panel-guard.ts, which answers the guarded
// entry). Nothing here imports the server, so the adapter can read it without pulling Hono in.
//
// The panel is PocketBase's own static build. It lives at `/_/` by default, which is the only path its bundle
// mentions; `panel.path` copies it somewhere else and rebases the two URLs that are absolute (src/adapter/panel.ts).

/** the path the panel has always been served at, and the default of `panel.path` */
export const PANEL_DEFAULT_PATH = "/_/";
/** where the Worker answers the guarded entry: the asset layer only ever invokes the Worker under /api */
export const PANEL_API = "/api/panel";
/**
 * The file the guarded entry is written as. Not `index.html`: the rules that send the panel's path to the handler
 * name `<path>index.html` too, and Cloudflare applies a rule to the Worker's own `env.ASSETS.fetch`, so a handler
 * reading `index.html` is answered with its own redirect. This name is the one the rules do not touch.
 */
export const PANEL_ENTRY_FILE = "entry.html";

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * `panel.path` as the rest of the code uses it: a leading and a trailing slash, no empty, `.` or `..` segment.
 * `/admin`, `/admin/` and `admin` all become `/admin/`.
 */
export function normalizePanelPath(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error('voidbase: panel.path is empty: name the path the panel is served at, such as { path: "/admin" }.');
  const segments = trimmed.split("/").filter(Boolean);
  if (!segments.length) throw new Error('voidbase: panel.path is "/", which is the app itself: give the panel a path of its own, such as "/admin".');
  for (const s of segments) {
    if (s === "." || s === "..") throw new Error(`voidbase: panel.path ${JSON.stringify(trimmed)} has a ${JSON.stringify(s)} segment: give a plain path such as "/admin".`);
    if (!SEGMENT.test(s)) throw new Error(`voidbase: panel.path ${JSON.stringify(trimmed)} has the segment ${JSON.stringify(s)}, which is not a path segment (letters, digits, "." , "_", "~" and "-").`);
  }
  const path = `/${segments.join("/")}/`;
  if (path === "/api/" || path.startsWith("/api/")) throw new Error(`voidbase: panel.path ${JSON.stringify(path)} is under /api, which is the Worker's own prefix: pick a path outside it.`);
  return path;
}

/**
 * The `_redirects` lines the adapter writes, in the order they are appended.
 *
 * `guard` puts the panel's front door behind the Worker: the asset layer answers everything outside `/api` itself,
 * so the only way for a check to run at all is a rule that sends the path to `/api/panel` (the same mechanism the
 * seo plugin uses for /robots.txt). `at` names the directory the panel's files are in, so one handler serves any
 * configured path without the deploy having to bake a var; it is validated as a same-origin path before use and it
 * grants nothing on its own (the superuser check happens first).
 *
 * `hide` takes `/_/` away: rules are applied before the asset layer looks for a file, so sending the old path to
 * `/api/panel` with no `at` makes every URL under it answer 404.
 */
export function panelRedirectLines(path: string, opts: { guard?: boolean; hide?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (opts.guard) {
    const to = `${PANEL_API}?at=${path}`;
    // the bare path, the directory, and the file the directory resolves to: all three are the panel's entry
    lines.push(`${path.slice(0, -1)} ${to} 302`, `${path} ${to} 302`, `${path}index.html ${to} 302`);
  }
  if (opts.hide && path !== PANEL_DEFAULT_PATH) {
    lines.push(`${PANEL_DEFAULT_PATH.slice(0, -1)} ${PANEL_API} 302`, `${PANEL_DEFAULT_PATH} ${PANEL_API} 302`, `${PANEL_DEFAULT_PATH}* ${PANEL_API} 302`);
  }
  return lines;
}
