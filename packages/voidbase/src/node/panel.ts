// Where the unmodified PocketBase admin panel comes from: POCKETBASE_UI_DIST, else a synced public/_ in this
// checkout, else a PocketBase checkout beside this repository, else the pinned release's committed ui/dist
// downloaded once into ~/.cache/voidbase. The chosen source is printed, because which one wins decides what the
// panel actually is and the difference is otherwise invisible.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unzipSync } from "fflate";
import { embedded } from "./embedded";
export const PANEL_VERSION = process.env.POCKETBASE_PANEL_VERSION ?? "0.40.2";
/** ~/.cache/voidbase (XDG_CACHE_HOME when set): the panel, cloudflared and whatever else is fetched once per machine. */
export const cacheRoot = (env: Record<string, string | undefined> = process.env) => resolve(`${env.XDG_CACHE_HOME ?? `${env.HOME ?? env.USERPROFILE ?? "."}/.cache`}/voidbase`);
const cacheDir = (version: string) => `${cacheRoot()}/panel-${version}`;
/** The package root: src/node is two directories below it, in a checkout and under node_modules alike. */
const PKG = resolve(import.meta.dir, "../..");
/**
 * A PocketBase checkout beside this repository, the way to work against a panel that has not been released yet.
 * The package is `packages/voidbase`, so the repository is two directories up and its sibling three. An installed
 * package sits under node_modules with no repository beside it, and a directory called `pocketbase` three levels
 * above someone else's node_modules is not one: only a checkout looks there.
 */
const siblingUiDist = (): string | undefined => (/[\\/]node_modules[\\/]/.test(PKG) ? undefined : resolve(PKG, "../../../pocketbase/ui/dist"));
export async function ensurePanelDir(): Promise<string> {
  const local: { dir: string | undefined; what: string }[] = [
    { dir: process.env.POCKETBASE_UI_DIST, what: "POCKETBASE_UI_DIST" },
    { dir: resolve(PKG, "public/_"), what: "the synced public/_ of this checkout" },
    { dir: siblingUiDist(), what: "the PocketBase checkout beside this repository" },
  ];
  for (const { dir, what } of local) if (dir && existsSync(`${dir}/index.html`)) { console.log(`voidbase: admin panel from ${dir} (${what})`); return dir; }
  // a standalone executable carries the panel: unpacked once into the cache
  const emb = await embedded();
  if (emb?.panel) {
    const dir = cacheDir(emb.panel.version);
    console.log(`voidbase: admin panel from ${dir} (the copy embedded in this executable, version ${emb.panel.version})`);
    if (!existsSync(`${dir}/index.html`)) {
      const files = unzipSync(Uint8Array.from(atob(emb.panel.zipBase64), (c) => c.charCodeAt(0)));
      for (const [name, bytes] of Object.entries(files)) { if (name.endsWith("/")) continue; mkdirSync(dirname(`${dir}/${name}`), { recursive: true }); writeFileSync(`${dir}/${name}`, bytes); }
      if (!existsSync(`${dir}/extensions.js`)) writeFileSync(`${dir}/extensions.js`, "// voidbase: no UI extensions configured\n");
    }
    return dir;
  }
  const cache = cacheDir(PANEL_VERSION);
  if (existsSync(`${cache}/index.html`)) { console.log(`voidbase: admin panel from ${cache} (the pinned PocketBase ${PANEL_VERSION} release, cached)`); return cache; }
  console.log(`voidbase: downloading the PocketBase ${PANEL_VERSION} admin panel (ui/dist) into ${cache}`);
  const res = await fetch(`https://codeload.github.com/pocketbase/pocketbase/tar.gz/refs/tags/v${PANEL_VERSION}`);
  if (!res.ok) throw new Error(`panel download failed: HTTP ${res.status} (set POCKETBASE_UI_DIST to a local ui/dist)`);
  mkdirSync(cache, { recursive: true });
  const tgz = `${cache}.tgz`; writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
  const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", cache, "--strip-components=3", `pocketbase-${PANEL_VERSION}/ui/dist`]);
  rmSync(tgz, { force: true });
  if (tar.exitCode !== 0) throw new Error(new TextDecoder().decode(tar.stderr));
  writeFileSync(`${cache}/extensions.js`, "// voidbase: no UI extensions configured\n");
  return cache;
}
