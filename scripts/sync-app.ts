// Copies a static app build (default: the SvelteKit starter's adapter-static output) into public/ so the same
// Worker serves the app at / and the PocketBase admin panel at /_/. Everything but public/_ is replaced.
//   bun run app:sync            # uses VOIDBASE_APP_DIR or ../pocketbase-sveltekit-starter/sk/build
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(process.env.VOIDBASE_APP_DIR ?? `${import.meta.dir}/../../pocketbase-sveltekit-starter/sk/build`);
const destArg = process.argv.indexOf("--dest");
const dest = resolve(destArg >= 0 ? process.argv[destArg + 1]! : `${import.meta.dir}/../public`);
if (!existsSync(`${src}/index.html`)) {
  console.error(`app build not found at ${src} (set VOIDBASE_APP_DIR; for the starter run \`bun run build\` in sk/)`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const entry of readdirSync(dest)) if (entry !== "_") rmSync(`${dest}/${entry}`, { recursive: true, force: true });
for (const entry of readdirSync(src)) {
  if (entry === "_") { console.warn("skipping the app's /_ directory: that path belongs to the admin panel"); continue; }
  cpSync(`${src}/${entry}`, `${dest}/${entry}`, { recursive: true });
}
console.log(`synced app ${src} -> ${dest} (${statSync(`${dest}/index.html`).size} bytes index.html)`);
