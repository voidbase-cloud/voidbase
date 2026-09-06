// GitHub releases through the REST API for scripts/release.sh, on machines without `gh` (the Workers Builds image):
//   bun scripts/gh-release.ts view <tag>                 prints {id, tag_name, html_url, assets} or exits 2 when there is no such release
//   bun scripts/gh-release.ts upload <tag> <file...>     attaches files, replacing same-named assets
//   bun scripts/gh-release.ts body <tag>                 prints the release notes
//   bun scripts/gh-release.ts notes <tag> <file>         replaces the release notes with the file's content
// GH_TOKEN (or GITHUB_TOKEN); GITHUB_REPOSITORY (default voidbase-cloud/voidbase); GITHUB_API_URL for a mock.
import { basename } from "node:path";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) { console.error("GH_TOKEN is not set"); process.exit(1); }
const repo = process.env.GITHUB_REPOSITORY ?? "voidbase-cloud/voidbase";
const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "voidbase-release" };
interface Asset { id: number; name: string }
interface Release { id: number; tag_name: string; html_url: string; body: string | null; upload_url: string; assets: Asset[] }
async function call<T>(method: string, url: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }): Promise<{ status: number; data: T }> {
  const h = raw ? { ...headers, "content-type": raw.type } : body !== undefined ? { ...headers, "content-type": "application/json" } : headers;
  const res = await fetch(url.startsWith("http") ? url : `${api}${url}`, { method, headers: h, body: raw ? raw.bytes : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data: unknown = text; try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, data: data as T };
}
const fail = (what: string, r: { status: number; data: unknown }) => { console.error(`${what}: HTTP ${r.status} ${typeof r.data === "string" ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300)}`); process.exit(1); };
const [cmd, tag, ...files] = process.argv.slice(2);
if (!cmd || !tag || !["view", "upload", "body", "notes"].includes(cmd)) { console.error("usage: bun scripts/gh-release.ts view|body <tag> | upload <tag> <file...> | notes <tag> <file>"); process.exit(2); }
const got = await call<Release>("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
if (got.status === 404) { console.error(`no release ${tag} in ${repo}`); process.exit(2); }
if (got.status !== 200) fail(`reading release ${tag}`, got);
const rel = got.data;
if (cmd === "view") console.log(JSON.stringify({ id: rel.id, tag_name: rel.tag_name, html_url: rel.html_url, assets: rel.assets.map((a) => a.name) }));
else if (cmd === "body") process.stdout.write(rel.body ?? "");
else if (cmd === "notes") {
  if (!files[0]) { console.error("notes: file missing"); process.exit(2); }
  const r = await call("PATCH", `/repos/${repo}/releases/${rel.id}`, { body: await Bun.file(files[0]).text() });
  if (r.status !== 200) fail(`updating the notes of ${tag}`, r);
  console.log(`notes of ${tag} updated`);
} else {
  if (!files.length) { console.error("upload: no files"); process.exit(2); }
  for (const f of files) {
    const name = basename(f), bytes = new Uint8Array(await Bun.file(f).arrayBuffer());
    const existing = rel.assets.find((a) => a.name === name);
    if (existing) { const d = await call("DELETE", `/repos/${repo}/releases/assets/${existing.id}`); if (d.status !== 204) fail(`replacing ${name}`, d); }
    const type = name.endsWith(".zip") ? "application/zip" : name.endsWith(".tgz") ? "application/gzip" : "text/plain";
    const r = await call<Asset>("POST", `${rel.upload_url.replace(/\{[^}]*\}$/, "")}?name=${encodeURIComponent(name)}`, undefined, { bytes, type });
    if (r.status !== 201) fail(`uploading ${name}`, r);
    console.log(`uploaded ${name} (${bytes.length} bytes)${existing ? " (replaced)" : ""}`);
  }
}
