// Where the unmodified PocketBase admin panel comes from: a synced public/_ in this checkout, else the pinned
// release's committed ui/dist downloaded once into ~/.cache/voidbase.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unzipSync } from "fflate";
import { embedded } from "./embedded";
export const PANEL_VERSION = process.env.POCKETBASE_PANEL_VERSION ?? "0.40.2";
/** ~/.cache/voidbase (XDG_CACHE_HOME when set): the panel, cloudflared and whatever else is fetched once per machine. */
export const cacheRoot = (env: Record<string, string | undefined> = process.env) => resolve(`${env.XDG_CACHE_HOME ?? `${env.HOME ?? env.USERPROFILE ?? "."}/.cache`}/voidbase`);
const cacheDir = (version: string) => `${cacheRoot()}/panel-${version}`;
export async function ensurePanelDir(): Promise<string> {
  const local = [process.env.POCKETBASE_UI_DIST, resolve(import.meta.dir, "../../public/_"), resolve(import.meta.dir, "../../../pocketbase/ui/dist")].filter((p): p is string => !!p);
  for (const p of local) if (existsSync(`${p}/index.html`)) return p;
  // a standalone executable carries the panel: unpacked once into the cache
  const emb = await embedded();
  if (emb?.panel) {
    const dir = cacheDir(emb.panel.version);
    if (!existsSync(`${dir}/index.html`)) {
      const files = unzipSync(Uint8Array.from(atob(emb.panel.zipBase64), (c) => c.charCodeAt(0)));
      for (const [name, bytes] of Object.entries(files)) { if (name.endsWith("/")) continue; mkdirSync(dirname(`${dir}/${name}`), { recursive: true }); writeFileSync(`${dir}/${name}`, bytes); }
      if (!existsSync(`${dir}/extensions.js`)) writeFileSync(`${dir}/extensions.js`, "// voidbase: no UI extensions configured\n");
    }
    return dir;
  }
  const cache = cacheDir(PANEL_VERSION);
  if (existsSync(`${cache}/index.html`)) return cache;
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
