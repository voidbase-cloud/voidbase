// Copies PocketBase's prebuilt admin panel (ui/dist) into public/_ so the Worker serves it at /_/.
// The panel is used unmodified; it talks to ../ relative to /_/, i.e. this Worker's /api.
//
// Optional branding (VOIDBASE_BRAND_DIR or --brand <dir>): a directory with any of
//   logo.svg, logo_white.svg, favicon.png   replace the panel's images
//   brand.json                              { "title": "...", "docsUrl": "https://..." }
// title replaces <title> in index.html, docsUrl rewrites the https://pocketbase.io/docs links in the bundles.
// The panel code itself is untouched; run without a brand dir to get the stock panel back.
//   bun scripts/sync-panel.ts [--brand <dir>] [--dest <dir>]
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const src = resolve(process.env.POCKETBASE_UI_DIST ?? `${import.meta.dir}/../../pocketbase/ui/dist`);
const dest = resolve(args.dest ?? `${import.meta.dir}/../public/_`);
const brandDir = args.brand ?? process.env.VOIDBASE_BRAND_DIR;
if (!existsSync(`${src}/index.html`)) {
  console.error(`panel dist not found at ${src} (set POCKETBASE_UI_DIST)`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
// PocketBase serves /_/extensions.js (UI extension registry). Without extensions it is an empty module.
writeFileSync(`${dest}/extensions.js`, "// voidbase: no UI extensions configured\n");
console.log(`synced panel ${src} -> ${dest} (${statSync(`${dest}/index.html`).size} bytes index.html)`);

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
