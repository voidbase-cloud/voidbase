// The `pwa` option of the Void adapter: what an installable app needs, written into the generated pb_public from
// what the app already declares. `manifest.webmanifest` (name, colours and icons, defaulted from void.json's
// `head`), the icon set (resized from one square PNG or SVG in the app's public/), and `sw.js`, a service worker
// that precaches the shell and speaks the update handshake `@voidbase-cloud/sdk/pwa` expects. The prerendered
// HTML gets a `<link rel="manifest">` and a `<meta name="theme-color">` when it has none. Registration is the
// client's job, so no script is injected.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

export interface PwaOptions {
  /** the app's name (default: void.json head.title, then package.json name) */
  name?: string;
  /** the name under the icon on a home screen (default: `name`) */
  shortName?: string;
  /** default: void.json head.meta `description` */
  description?: string;
  /** default: void.json head.meta `theme-color` */
  themeColor?: string;
  /** the splash screen's background (default: `themeColor`) */
  backgroundColor?: string;
  /** one square PNG or SVG in the app's public/, the source of the icon set */
  icon?: string;
  /** the manifest's start_url (default "/") */
  start?: string;
  /** the manifest's scope (default "/") */
  scope?: string;
  /** URL paths under pb_public to precache beside the shell, such as "/fonts/inter.woff2" */
  precache?: string[];
}

export interface PwaResult {
  /** the hash of the shell's contents; changes when the build changes, so the worker updates */
  version: string;
  /** what was written, relative to pb_public */
  files: string[];
  /** the URL paths sw.js precaches */
  precache: string[];
}

/** where the icon set goes inside pb_public */
export const ICONS_DIR = "icons";
export const MANIFEST_FILE = "manifest.webmanifest";
export const WORKER_FILE = "sw.js";
/** the client build's hashed files live here (Vite's build.assetsDir); the worker serves them cache first */
export const ASSETS_PREFIX = "/assets/";
/** the two PNG sizes an install needs (Chrome asks for 192 and 512) */
export const PNG_SIZES = [192, 512];
/** the prefix every cache the worker owns is named with, so a new version can drop the old ones */
export const CACHE_PREFIX = "voidbase-pwa-";

interface HeadDefaults { title?: string; description?: string; themeColor?: string }

/** void.json's `head` (Void's default tags for every page), the source of the manifest's defaults. */
export function readHeadDefaults(root: string): HeadDefaults {
  const out: HeadDefaults = {};
  try {
    const cfg = JSON.parse(readFileSync(join(root, "void.json"), "utf8")) as { head?: { title?: string; meta?: { name?: string; content?: string }[] } };
    out.title = cfg.head?.title;
    for (const m of cfg.head?.meta ?? []) {
      if (m.name === "description" && m.content) out.description = m.content;
      if (m.name === "theme-color" && m.content) out.themeColor = m.content;
    }
  } catch { /* no void.json, or not JSON: no defaults */ }
  return out;
}

export interface ManifestIcon { src: string; sizes: string; type: string }

/** The resolved manifest: the options over void.json's head over package.json's name. Undefined fields are left out. */
export function generateManifest(root: string, opts: PwaOptions, icons: ManifestIcon[]): Record<string, unknown> {
  const head = readHeadDefaults(root);
  let pkgName: string | undefined;
  try { pkgName = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }).name; } catch { /* no package.json */ }
  const name = opts.name ?? head.title ?? pkgName ?? "App";
  const themeColor = opts.themeColor ?? head.themeColor;
  const manifest: Record<string, unknown> = {
    name,
    short_name: opts.shortName ?? name,
    description: opts.description ?? head.description,
    start_url: opts.start ?? "/",
    scope: opts.scope ?? "/",
    display: "standalone",
    theme_color: themeColor,
    background_color: opts.backgroundColor ?? themeColor,
    icons,
  };
  for (const k of Object.keys(manifest)) if (manifest[k] === undefined) delete manifest[k];
  return manifest;
}

// ---- the icon set ------------------------------------------------------------------------------------------------

/** Writes the icons under <publicDir>/icons from the source file and returns their manifest entries. */
export async function writeIcons(root: string, publicDir: string, icon: string): Promise<{ icons: ManifestIcon[]; files: string[]; note?: string }> {
  const source = resolve(root, "public", icon);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`voidbase: pwa.icon "${icon}" is not a file under public/: the icon set is written from one square PNG or SVG there.`);
  const outDir = join(publicDir, ICONS_DIR);
  mkdirSync(outDir, { recursive: true });
  const bytes = new Uint8Array(readFileSync(source));
  const icons: ManifestIcon[] = [];
  const files: string[] = [];
  const putPng = (size: number, png: Uint8Array) => {
    const file = `icon-${size}.png`;
    writeFileSync(join(outDir, file), png);
    icons.push({ src: `/${ICONS_DIR}/${file}`, sizes: `${size}x${size}`, type: "image/png" });
    files.push(`${ICONS_DIR}/${file}`);
  };

  if (extname(source).toLowerCase() === ".svg") {
    // the SVG scales to any size on its own; the PNGs need a rasterizer, which only sharp (an optional install)
    // provides: Photon reads bitmaps only
    writeFileSync(join(outDir, "icon.svg"), bytes);
    icons.push({ src: `/${ICONS_DIR}/icon.svg`, sizes: "any", type: "image/svg+xml" });
    files.push(`${ICONS_DIR}/icon.svg`);
    const sharp = await loadSharp();
    if (!sharp) return { icons, files, note: "PNG icons need sharp (bun add -d sharp); the SVG alone is written" };
    for (const size of PNG_SIZES) putPng(size, new Uint8Array(await sharp(bytes).resize(size, size).png().toBuffer()));
    return { icons, files };
  }

  // a bitmap: Photon, the resizer the thumbnails already use (Rust to wasm, no native install)
  const P = await import("#platform/photon");
  let img: InstanceType<typeof P.PhotonImage>;
  try { img = P.PhotonImage.new_from_byteslice(bytes); } catch (err) { throw new Error(`voidbase: pwa.icon "${icon}" could not be decoded as an image (${err instanceof Error ? err.message : String(err)}).`); }
  try {
    const w = img.get_width(), h = img.get_height();
    if (w !== h) {
      // a square is cut from the middle, so the icon is not stretched
      const side = Math.min(w, h), x = Math.floor((w - side) / 2), y = Math.floor((h - side) / 2);
      const cropped = P.crop(img, x, y, x + side, y + side);
      img.free(); img = cropped;
    }
    for (const size of PNG_SIZES) {
      const resized = P.resize(img, size, size, P.SamplingFilter.Lanczos3);
      try { putPng(size, resized.get_bytes()); } finally { resized.free(); }
    }
  } finally { img.free(); }
  return { icons, files };
}

type Sharp = (input: Uint8Array) => { resize(w: number, h: number): { png(): { toBuffer(): Promise<Buffer> } } };
/** sharp when it is installed; the specifier is a variable so a checkout without it still typechecks and bundles */
async function loadSharp(): Promise<Sharp | null> {
  try { const name = "sharp"; const mod = (await import(name)) as { default?: Sharp }; return mod.default ?? null; } catch { return null; }
}

// ---- the shell and its version ----------------------------------------------------------------------------------

/** Every file under dir as a URL path, skipping the panel (`_/`), dotfiles and what this module writes itself. */
function walkPublic(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((entry) => {
    if (entry.startsWith(".") || (dir === base && entry === "_")) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walkPublic(full, base);
    return ["/" + relative(base, full).split("\\").join("/")];
  });
}

/** the URL a prerendered page is served at: /index.html is /, /docs/index.html is /docs/, /faq.html stays */
const pageUrl = (path: string) => (basename(path) === "index.html" ? path.slice(0, -"index.html".length) : path);

/**
 * The shell: every prerendered page (by the URL it is served at), everything under the assets prefix (the
 * client build's hashed files), and the `precache` list, which has to name files that exist: a missing entry
 * fails `cache.addAll` at install time and the worker never installs, which is the kind of silence nobody debugs.
 */
export function precacheList(publicDir: string, extra: string[] = []): string[] {
  const all = walkPublic(publicDir);
  const list = new Set<string>();
  for (const path of all) {
    if (path === `/${MANIFEST_FILE}` || path === `/${WORKER_FILE}` || path === "/404.html") continue;
    if (path.endsWith(".html")) list.add(pageUrl(path));
    else if (path.startsWith(ASSETS_PREFIX)) list.add(path);
  }
  for (const raw of extra) {
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    const file = path.endsWith("/") ? `${path}index.html` : path; // "/docs/" is the prerendered /docs/index.html
    if (!all.includes(file)) throw new Error(`voidbase: pwa.precache names "${raw}", which the client build does not have under pb_public. Only files that exist can be precached: a missing one stops the service worker from installing at all.`);
    list.add(path);
  }
  return [...list].sort();
}

/** the file a precached URL path reads from, for the version hash */
const fileOf = (publicDir: string, path: string) => join(publicDir, path.endsWith("/") ? `${path}index.html` : path);

/** A short hash of the shell's contents: a new build with any change to the shell is a new version of the worker. */
export function versionOf(publicDir: string, precache: string[]): string {
  const hash = createHash("sha256");
  for (const path of precache) {
    hash.update(path); hash.update("\0");
    const file = fileOf(publicDir, path);
    if (existsSync(file)) hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

// ---- the HTML ------------------------------------------------------------------------------------------------

/** Adds the manifest link and the theme colour to a page when it has none; the client build's own tags win. */
export function injectHead(html: string, themeColor?: string): string {
  const tags: string[] = [];
  if (!/<link[^>]*\brel=["']?manifest\b/i.test(html)) tags.push(`<link rel="manifest" href="/${MANIFEST_FILE}">`);
  if (themeColor && !/<meta[^>]*\bname=["']?theme-color\b/i.test(html)) tags.push(`<meta name="theme-color" content="${escapeAttr(themeColor)}">`);
  if (!tags.length) return html;
  const insert = tags.join("");
  const headEnd = /<\/head\s*>/i.exec(html);
  if (headEnd) return html.slice(0, headEnd.index) + insert + html.slice(headEnd.index);
  const headStart = /<head(\s[^>]*)?>/i.exec(html);
  if (headStart) { const at = headStart.index + headStart[0].length; return html.slice(0, at) + insert + html.slice(at); }
  // a page with no <head> element: a link or meta ahead of the first body content still lands in the head
  const doctype = /<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype.index + doctype[0].length : 0;
  return html.slice(0, at) + insert + html.slice(at);
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// ---- the service worker ------------------------------------------------------------------------------------------

export interface WorkerConfig { version: string; precache: string[]; start: string }

/** sw.js: dependency free, one screen per concern, because it is the file people debug. */
export function generateServiceWorker(cfg: WorkerConfig): string {
  const precache = cfg.precache.map((p) => `  ${JSON.stringify(p)},`).join("\n");
  return `// Generated by voidbase's Void adapter (the \`pwa\` option). Do not edit: the next build rewrites it.
//
// What it does, in the order people debug it:
//   install    caches the shell listed in PRECACHE under a cache named after VERSION. It does not skip waiting:
//              the page decides when to switch (the update prompt), and posts SKIP_WAITING when it has.
//   activate   drops the caches of earlier versions, takes over the open pages, and tells each of them
//              { type: "UPDATED", version }.
//   fetch      navigations go to the network first and fall back to the cached page, then the shell; hashed
//              assets come from the cache first; /api/* and /_/* are never touched.
//   message    { type: "SKIP_WAITING" } activates a waiting version now.
//              { type: "UNREGISTER" } clears the caches and unregisters the worker, then answers the sender with
//              { type: "UNREGISTERED" }: the way out of a stuck worker.
// The client side of this handshake is @voidbase-cloud/sdk/pwa.

const VERSION = ${JSON.stringify(cfg.version)};
const CACHE = ${JSON.stringify(CACHE_PREFIX)} + VERSION;
const SHELL = ${JSON.stringify(cfg.start)}; // served for a navigation the network cannot answer
const ASSETS = ${JSON.stringify(ASSETS_PREFIX)}; // the client build's hashed files: cache first
const NEVER = ["/api/", "/_/"]; // voidbase's API and panel: always the network
const PRECACHE = [
${precache}
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(${JSON.stringify(CACHE_PREFIX)}) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: "window" })) {
      client.postMessage({ type: "UPDATED", version: VERSION });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") { event.respondWith(networkFirst(request, url)); return; }
  if (url.pathname.startsWith(ASSETS) || PRECACHE.includes(url.pathname)) event.respondWith(cacheFirst(request));
});

async function networkFirst(request, url) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(CACHE);
    const page = (await cache.match(url.pathname)) || (await cache.match(url.pathname + ".html")) || (await cache.match(SHELL));
    if (page) return page;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "UNREGISTER") event.waitUntil(unregister(event.source));
});

async function unregister(client) {
  for (const name of await caches.keys()) {
    if (name.startsWith(${JSON.stringify(CACHE_PREFIX)})) await caches.delete(name);
  }
  await self.registration.unregister();
  if (client) client.postMessage({ type: "UNREGISTERED" });
}
`;
}

// ---- the pass ------------------------------------------------------------------------------------------------

/** Writes the manifest, the icons and the worker into publicDir and tags the prerendered pages. Idempotent. */
export async function writePwa(root: string, publicDir: string, opts: PwaOptions): Promise<PwaResult> {
  mkdirSync(publicDir, { recursive: true });
  const files: string[] = [];
  const iconSet = opts.icon ? await writeIcons(root, publicDir, opts.icon) : { icons: [], files: [] };
  files.push(...iconSet.files);
  if (iconSet.note) console.warn(`voidbase: pwa: ${iconSet.note}`);

  const manifest = generateManifest(root, opts, iconSet.icons);
  writeFileSync(join(publicDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  files.push(MANIFEST_FILE);

  // the pages first, so the version hashes what is served, tags included
  const themeColor = typeof manifest.theme_color === "string" ? manifest.theme_color : undefined;
  for (const path of walkPublic(publicDir)) {
    if (!path.endsWith(".html")) continue;
    const file = join(publicDir, path);
    const html = readFileSync(file, "utf8");
    const tagged = injectHead(html, themeColor);
    if (tagged !== html) writeFileSync(file, tagged);
  }

  const precache = precacheList(publicDir, opts.precache);
  const version = versionOf(publicDir, precache);
  const start = typeof manifest.start_url === "string" ? manifest.start_url : "/";
  writeFileSync(join(publicDir, WORKER_FILE), generateServiceWorker({ version, precache, start }));
  files.push(WORKER_FILE);
  return { version, files, precache };
}
