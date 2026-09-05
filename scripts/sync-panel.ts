// Copies PocketBase's prebuilt admin panel (ui/dist) into public/_ so the Worker serves it at /_/.
// The panel is used unmodified; it talks to ../ relative to /_/, i.e. this Worker's /api.
import { cpSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(process.env.POCKETBASE_UI_DIST ?? `${import.meta.dir}/../../pocketbase/ui/dist`);
const dest = resolve(`${import.meta.dir}/../public/_`);
if (!existsSync(`${src}/index.html`)) {
  console.error(`panel dist not found at ${src} (set POCKETBASE_UI_DIST)`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
// PocketBase serves /_/extensions.js (UI extension registry). Without extensions it is an empty module.
writeFileSync(`${dest}/extensions.js`, "// voidbase: no UI extensions configured\n");
console.log(`synced panel ${src} -> ${dest} (${statSync(`${dest}/index.html`).size} bytes index.html)`);
