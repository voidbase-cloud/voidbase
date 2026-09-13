// `voidbase wrap <url>` (src/node/wrap.ts): an extended project around an instance, against an instance, a marketplace and
// GitHub's tarballs on this machine. The plugins land at the commit the instance runs, what an admin set becomes config.json,
// the shipped plugins it removed stay removed, and nothing is reinstalled by hand.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLock } from "../../src/node/installed";
import { wrapInstance } from "../../src/node/wrap";

const dirs: string[] = []; const servers: { stop(force?: boolean): void }[] = [];
const before = process.env.VOIDBASE_TARBALL_URL;
afterAll(() => { for (const s of servers) s.stop(true); for (const d of dirs) rmSync(d, { recursive: true, force: true }); if (before === undefined) delete process.env.VOIDBASE_TARBALL_URL; else process.env.VOIDBASE_TARBALL_URL = before; });

const COMMIT = "a".repeat(40);
const src = mkdtempSync(join(tmpdir(), "vb-wrap-src-")); dirs.push(src);
const top = join(src, `shield-${COMMIT}`); mkdirSync(top, { recursive: true });
writeFileSync(join(top, "manifest.json"), JSON.stringify({ name: "shield", version: "0.3.0", tier: "community", voidbase: "*" }));
writeFileSync(join(top, "main.js"), "export default { apply() {} };\n");
Bun.spawnSync(["tar", "-czf", join(src, "shield.tgz"), "-C", src, `shield-${COMMIT}`]);

let approvedCommit = COMMIT;
const outside = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/registry/v1/index.json") return Response.json({ schemaVersion: 1, marketplace: { name: "local", url: MARKET }, generatedOn: "2026-09-13", templates: [], plugins: [{ name: "shield", repository: "me/shield", title: "Shield", summary: "s", latest: "0.3.0", versions: [{ version: "0.3.0", manifest: { name: "shield", version: "0.3.0", tier: "community", voidbase: "*" }, source: { repository: "me/shield", commit: approvedCommit }, publishedOn: "2026-09-13" }] }] });
  if (u.pathname === `/tarballs/me/shield/tar.gz/${COMMIT}`) return new Response(Bun.file(join(src, "shield.tgz")));
  return new Response("not found", { status: 404 });
} });
servers.push(outside);
const MARKET = `http://127.0.0.1:${outside.port}`;
process.env.VOIDBASE_TARBALL_URL = `${MARKET}/tarballs`;

/** an instance that declares shield at COMMIT, with a field an admin set and one at its default, and mail removed */
const instance = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api/collections/_superusers/auth-with-password") return Response.json({ token: "tok" });
  if (req.headers.get("authorization") !== "tok") return Response.json({ message: "no" }, { status: 401 });
  if (u.pathname === "/api/health") return Response.json({ data: { voidbase: { version: "0.9.0-beta.61" } } });
  if (u.pathname === "/api/plugins/declaration") return Response.json({ mode: "declaration", plugins: { shield: { version: "0.3.0", marketplace: MARKET, source: { repository: "me/shield", commit: COMMIT } } }, disabled: ["mail"], marketplaces: [MARKET] });
  if (u.pathname === "/api/plugins/config") return Response.json({ shield: { editable: true, fields: { level: { value: "strict", source: "instance" }, window: { value: 60, source: "default" } } } });
  return Response.json({ message: "not found" }, { status: 404 });
} });
servers.push(instance);

test("the plugins the instance ran land at its commit, what an admin set is config.json, and removed shipped plugins stay removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-wrap-")); dirs.push(dir);
  const lines: string[] = [];
  const w = await wrapInstance({ url: `http://127.0.0.1:${instance.port}`, email: "a@b.c", password: "p", dir, log: (l) => lines.push(l) });
  expect(w).toMatchObject({ plugins: [{ name: "shield", version: "0.3.0", commit: COMMIT }], configured: ["shield"], removed: ["mail"], voidbase: "0.9.0-beta.61", scaffolded: ["package.json", "index.ts"] });
  const lock = readLock(dir);
  expect(lock.plugins.shield).toMatchObject({ version: "0.3.0", source: { commit: COMMIT }, marketplace: MARKET });
  expect(lock.disabled).toEqual(["mail"]);
  expect(existsSync(join(dir, "pb_plugins/shield/main.js"))).toBe(true);
  // only what was set on the instance: a field at its default is not the project's to declare
  expect(JSON.parse(readFileSync(join(dir, "pb_plugins/shield/config.json"), "utf8"))).toEqual({ level: "strict" });
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["@voidbase-cloud/voidbase"]).toBe("0.9.0-beta.61");
  expect(readFileSync(join(dir, "index.ts"), "utf8")).toContain('pluginsDir: "pb_plugins"');
  expect(lines.at(-1)).toContain("1 plugin(s), 1 configured, 1 shipped plugin(s) kept removed");
});

test("a marketplace that no longer approves the commit the instance runs is refused rather than installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-wrap-")); dirs.push(dir);
  approvedCommit = "b".repeat(40);
  await expect(wrapInstance({ url: `http://127.0.0.1:${instance.port}`, email: "a@b.c", password: "p", dir })).rejects.toThrow(/approves shield 0\.3\.0 at|could not be fetched/);
  approvedCommit = COMMIT;
});
