// Copies PocketBase's prebuilt admin panel (ui/dist) into public/_ so the Worker serves it at /_/.
// The panel is used unmodified; it talks to ../ relative to /_/, i.e. this Worker's /api.
//
// Optional branding (VOIDBASE_BRAND_DIR or --brand <dir>): a directory with any of
//   logo.svg, logo_white.svg, favicon.png   replace the panel's images
//   brand.json                              { "title": "...", "docsUrl": "https://..." }
// title replaces <title> in index.html, docsUrl rewrites the https://pocketbase.io/docs links in the bundles.
// The panel code itself is untouched; run without a brand dir to get the stock panel back.
//   bun scripts/sync-panel.ts [--brand <dir>] [--dest <dir>]
// Source: POCKETBASE_UI_DIST, else a PocketBase checkout beside this repository (../pocketbase/ui/dist from the
// repository root, which is two directories above this package), else the pinned release tarball
// (POCKETBASE_PANEL_VERSION) cached under ~/.cache/voidbase. Which one won is printed with the result.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const PANEL_VERSION = process.env.POCKETBASE_PANEL_VERSION ?? "0.40.2";
const PKG = resolve(import.meta.dir, "..");   // packages/voidbase; the repository is two directories above it
// Only a checkout looks for the sibling. An installed package sits under node_modules, where three directories up is
// the consumer's project and a `pocketbase` directory there is somebody else's, not the checkout this means.
const sibling = /[\\/]node_modules[\\/]/.test(PKG) ? undefined : resolve(PKG, "../../../pocketbase/ui/dist");
let src = process.env.POCKETBASE_UI_DIST ? resolve(process.env.POCKETBASE_UI_DIST) : sibling;
let from = process.env.POCKETBASE_UI_DIST ? "POCKETBASE_UI_DIST" : "the PocketBase checkout beside this repository";
const dest = resolve(args.dest ?? `${import.meta.dir}/../public/_`);
const brandDir = args.brand ?? process.env.VOIDBASE_BRAND_DIR;
if (!src || !existsSync(`${src}/index.html`)) {
  // no local PocketBase checkout: fetch the committed ui/dist of the pinned release once into a cache
  const cache = resolve(`${process.env.XDG_CACHE_HOME ?? `${process.env.HOME}/.cache`}/voidbase/panel-${PANEL_VERSION}`);
  if (!existsSync(`${cache}/index.html`)) {
    console.log(`downloading PocketBase ${PANEL_VERSION} admin panel (ui/dist) from GitHub`);
    const res = await fetch(`https://codeload.github.com/pocketbase/pocketbase/tar.gz/refs/tags/v${PANEL_VERSION}`);
    if (!res.ok) { console.error(`download failed: HTTP ${res.status} (set POCKETBASE_UI_DIST to a local ui/dist)`); process.exit(1); }
    mkdirSync(cache, { recursive: true });
    const tgz = `${cache}.tgz`; writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
    const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", cache, "--strip-components=3", `pocketbase-${PANEL_VERSION}/ui/dist`]);
    if (tar.exitCode !== 0) { console.error(new TextDecoder().decode(tar.stderr)); process.exit(1); }
    rmSync(tgz, { force: true });
  }
  src = cache;
  from = `the pinned PocketBase ${PANEL_VERSION} release, cached`;
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
// PocketBase serves /_/extensions.js (UI extension registry). Without extensions it is an empty module.
writeFileSync(`${dest}/extensions.js`, "// voidbase: no UI extensions configured\n");
console.log(`synced panel ${src} (${from}) -> ${dest} (${statSync(`${dest}/index.html`).size} bytes index.html)`);

if (brandDir) {
  const brand = resolve(brandDir);
  const applied: string[] = [];
  for (const img of ["logo.svg", "logo_white.svg", "favicon.png"]) {
    if (existsSync(`${brand}/${img}`)) { cpSync(`${brand}/${img}`, `${dest}/images/${img}`); applied.push(img); }
  }
  const meta = existsSync(`${brand}/brand.json`) ? (JSON.parse(readFileSync(`${brand}/brand.json`, "utf8")) as { title?: string; docsUrl?: string }) : {};
  if (meta.title) {
    const index = `${dest}/index.html`;
    writeFileSync(index, readFileSync(index, "utf8").replace(/<title>[^<]*<\/title>/, `<title>${meta.title.replace(/[<&]/g, "")}</title>`));
    applied.push(`title "${meta.title}"`);
  }
  if (meta.docsUrl) {
    const docsUrl = meta.docsUrl.replace(/\/$/, "");
    let files = 0;
    for (const f of readdirSync(`${dest}/assets`).filter((f) => f.endsWith(".js"))) {
      const p = `${dest}/assets/${f}`; const code = readFileSync(p, "utf8");
      const next = code.replace(/https:\/\/pocketbase\.io\/docs/g, docsUrl);
      if (next !== code) { writeFileSync(p, next); files++; }
    }
    applied.push(`docs links -> ${docsUrl} in ${files} bundles`);
  }
  console.log(`branding from ${brand}: ${applied.length ? applied.join(", ") : "nothing to apply (expected logo.svg, logo_white.svg, favicon.png or brand.json)"}`);
}
// Cloudflare 404-page handling: the panel index doubles as its 404 page (PocketBase serves the panel for any /_/ path)
import { copyFileSync } from "node:fs";
if (existsSync(`${dest}/index.html`)) copyFileSync(`${dest}/index.html`, `${dest}/404.html`);
