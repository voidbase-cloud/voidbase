// Where the unmodified PocketBase admin panel comes from: a synced public/_ in this checkout, else the pinned
// release's committed ui/dist downloaded once into ~/.cache/voidbase.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export const PANEL_VERSION = process.env.POCKETBASE_PANEL_VERSION ?? "0.40.2";
export async function ensurePanelDir(): Promise<string> {
  const local = [process.env.POCKETBASE_UI_DIST, resolve(import.meta.dir, "../../public/_"), resolve(import.meta.dir, "../../../pocketbase/ui/dist")].filter((p): p is string => !!p);
  for (const p of local) if (existsSync(`${p}/index.html`)) return p;
  const cache = resolve(`${process.env.XDG_CACHE_HOME ?? `${process.env.HOME}/.cache`}/voidbase/panel-${PANEL_VERSION}`);
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
