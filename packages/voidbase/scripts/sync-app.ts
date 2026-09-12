// Copies a static app build (default: the SvelteKit starter's adapter-static output) into public/ so the same
// Worker serves the app at / and the PocketBase admin panel at /_/. Everything but public/_ is replaced.
//   bun run app:sync            # uses VOIDBASE_APP_DIR, else the starter checkout beside this repository
//                               # (../pocketbase-sveltekit-starter/sk/build from the repository root, which is two
//                               # directories above this package); the chosen source is printed with the result
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");   // packages/voidbase; the repository is two directories above it
// Only a checkout looks for the sibling: three directories above an installed package is the consumer's project.
const sibling = /[\\/]node_modules[\\/]/.test(PKG) ? undefined : resolve(PKG, "../../../pocketbase-sveltekit-starter/sk/build");
const src = process.env.VOIDBASE_APP_DIR ? resolve(process.env.VOIDBASE_APP_DIR) : sibling;
const from = process.env.VOIDBASE_APP_DIR ? "VOIDBASE_APP_DIR" : "the starter checkout beside this repository";
const destArg = process.argv.indexOf("--dest");
const dest = resolve(destArg >= 0 ? process.argv[destArg + 1]! : `${import.meta.dir}/../public`);
if (!src || !existsSync(`${src}/index.html`)) {
  console.error(`app build not found${src ? ` at ${src}` : ""} (set VOIDBASE_APP_DIR; for the starter run \`bun run build\` in sk/)`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const entry of readdirSync(dest)) if (entry !== "_") rmSync(`${dest}/${entry}`, { recursive: true, force: true });
for (const entry of readdirSync(src)) {
  if (entry === "_") { console.warn("skipping the app's /_ directory: that path belongs to the admin panel"); continue; }
  if (entry === "_redirects") continue; // becomes void.json routing.redirects (host-aware); Cloudflare's asset layer would reject host sources
  cpSync(`${src}/${entry}`, `${dest}/${entry}`, { recursive: true });
}
console.log(`synced app ${src} (${from}) -> ${dest} (${statSync(`${dest}/index.html`).size} bytes index.html)`);
// Cloudflare 404-page handling: deep links get index.html (status 404) from the asset layer, never from the Worker
if (!existsSync(`${dest}/404.html`)) copyFileSync(`${dest}/index.html`, `${dest}/404.html`);
