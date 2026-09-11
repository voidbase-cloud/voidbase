// The `panel` option of the Void adapter: the admin panel under the app's own path, behind the app's own check.
//
//   voidbaseAdapter({ panel: { path: "/admin", guard: "superuser", hide: true } })
//
// **What the panel's build actually hardcodes.** It is PocketBase's own static build (src/node/panel.ts pins the
// version), and it was measured rather than assumed, on 0.40.2:
//   - index.html references everything relatively (`./assets/...`, `./libs/...`), so it needs no rewriting at all;
//   - the router is a hash router (`#/collections`), so there is no router base to rebase;
//   - the API base is `new PocketBase("../")`, which the SDK resolves as origin + location.pathname + "../". That
//     is right at `/_/` and at any other one-segment path, and wrong at a deeper one (`/a/b/` would call
//     `/a/api/...`). So the literal is rewritten to `/`, which is origin-rooted and depth-independent -- and the
//     API of a voidbase instance is always at the origin's `/api`;
//   - two absolute `/_/` references exist in the bundle. One derives the "API example" URL and already falls back
//     to `window.location.origin` when the path is not `/_/`, so it is right when moved. The other loads
//     `/_/extensions.js`, and is rewritten to the configured path.
// Nothing else in the build names `/_/`. If a future panel version stops matching, the rewrite fails the build
// with what it looked for rather than shipping a panel whose API calls go somewhere else.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePanelDir } from "../node/panel";
import { normalizePanelPath, panelRedirectLines, PANEL_DEFAULT_PATH } from "../server/panel-paths";

export interface PanelOptions {
  /** where the panel is served (default `/_/`, today's behaviour); `/admin` and `/admin/` mean the same thing */
  path?: string;
  /** `"superuser"` puts the panel's entry behind a voidbase superuser session, answering 404 without one (default false) */
  guard?: "superuser" | false;
  /** take `/_/` away, so the panel is only at `path` (default false, so an upgrade does not break a bookmark) */
  hide?: boolean;
}

export interface PanelResult {
  /** the path with its slashes, `/admin/` */
  path: string;
  guard: "superuser" | false;
  /** whether `/_/` was taken away */
  hidden: boolean;
  /** the entries copied into `<pb_public><path>` (0 when the path is the default one, where the panel already is) */
  copied: number;
  /** the panel bundles whose base URL was rewritten */
  rebased: string[];
  /** the `_redirects` lines this pass added */
  rules: string[];
}

/** `new PocketBase("../")` in the panel's bundles: the API base, relative to wherever the index is served */
const BASE_CALL = /(\bnew\s+[A-Za-z_$][\w$]*\s*\(\s*)(["'`])\.\.\/\2/g;
/** the one absolute URL the bundle loads, the UI extension registry */
const EXTENSIONS = /(["'`])\/_\/extensions\.js\1/g;
const EXTENSIONS_STUB = "// voidbase: no UI extensions configured\n";

/**
 * Rewrites the API base and the extensions URL in the copied panel's bundles. Returns the files it changed; throws
 * when no bundle carried the base at all, because a panel that talks to the wrong origin is worse than a build error.
 */
export function rebasePanelAssets(dir: string, path: string): string[] {
  const assets = join(dir, "assets");
  if (!existsSync(assets)) throw new Error(`voidbase: panel: ${assets} does not exist, so the panel's build is not the one this expects (assets/*.js). Set POCKETBASE_UI_DIST to a ui/dist, or leave panel.path at ${PANEL_DEFAULT_PATH}.`);
  const changed: string[] = [];
  let bases = 0, extensions = 0;
  for (const name of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
    const file = join(assets, name);
    const code = readFileSync(file, "utf8");
    let next = code.replace(BASE_CALL, (_m, head: string, quote: string) => { bases++; return `${head}${quote}/${quote}`; });
    next = next.replace(EXTENSIONS, (_m, quote: string) => { extensions++; return `${quote}${path}extensions.js${quote}`; });
    if (next !== code) { writeFileSync(file, next); changed.push(`assets/${name}`); }
  }
  if (!bases) throw new Error([
    `voidbase: panel: none of the panel's bundles in ${assets} constructs its API base as "../", which is what serving the panel at ${path} rewrites to "/".`,
    "The panel's build changed shape (POCKETBASE_PANEL_VERSION pins it). Check what the new one does with its base URL before moving the panel, or leave panel.path at " + PANEL_DEFAULT_PATH + ".",
  ].join("\n"));
  if (!extensions) console.warn(`voidbase: panel: no bundle loads /_/extensions.js, so nothing was rebased for it; the panel logs a warning for a missing extensions registry and boots anyway`);
  return changed;
}

/** Appends lines to `<dir>/_redirects`, leaving a source something already rules alone (the seo pass's rule). */
export function appendPanelRedirects(dir: string, rules: string[]): string[] {
  if (!rules.length) return [];
  const file = join(dir, "_redirects");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const ruled = new Set(current.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const lines = rules.filter((l) => !ruled.has(l.split(" ")[0]!));
  if (!lines.length) return [];
  writeFileSync(file, `${current.trimEnd()}${current.trim() ? "\n" : ""}${lines.join("\n")}\n`);
  return lines;
}

/**
 * The whole pass, run last so the pwa and locales passes never see the panel's own HTML: the panel's files under
 * the path, rebased, and the `_redirects` rules for the guard and for `hide`. Idempotent: the directory is
 * replaced, and a rule already in the file is not written twice.
 */
export async function writePanel(publicDir: string, opts: PanelOptions): Promise<PanelResult> {
  const path = normalizePanelPath(opts.path ?? PANEL_DEFAULT_PATH);
  const guard = opts.guard === "superuser" ? "superuser" : false;
  const hide = !!opts.hide;
  if (hide && path === PANEL_DEFAULT_PATH) throw new Error(`voidbase: panel.hide takes ${PANEL_DEFAULT_PATH} away, and panel.path is still ${PANEL_DEFAULT_PATH}: give the panel a path of its own first, such as { path: "/admin", hide: true }.`);
  if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) return { path, guard, hidden: hide, copied: 0, rebased: [], rules: [] };

  let copied = 0;
  let rebased: string[] = [];
  if (path !== PANEL_DEFAULT_PATH) {
    const dest = join(publicDir, path);
    // a rule is applied before the asset layer looks for a file, and the copy replaces whatever is there: an app
    // page on this path would disappear, so say so rather than let it go quietly
    if (existsSync(dest)) console.warn(`voidbase: panel: the build already has ${path} in pb_public, and the panel replaces it: those files are no longer served. Give the panel a path of its own.`);
    const src = await ensurePanelDir();
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) { cpSync(join(src, entry), join(dest, entry), { recursive: true }); copied++; }
    if (!existsSync(join(dest, "extensions.js"))) { writeFileSync(join(dest, "extensions.js"), EXTENSIONS_STUB); copied++; }
    rebased = rebasePanelAssets(dest, path);
    // Cloudflare answers an unmatched path with the nearest 404.html; the panel's index is its own, the way
    // scripts/sync-panel.ts writes it for /_/. Not under a guard: that copy would be the index, readable.
    const index = join(dest, "index.html");
    if (guard) rmSync(join(dest, "404.html"), { force: true });
    else if (existsSync(index)) cpSync(index, join(dest, "404.html"));
  }
  const rules = appendPanelRedirects(publicDir, panelRedirectLines(path, { guard: !!guard, hide }));
  return { path, guard, hidden: hide, copied, rebased, rules };
}
