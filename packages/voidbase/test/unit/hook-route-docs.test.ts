// What a pb_hooks route answers, read from its source, so the API description and the generated types can say it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHooksDir } from "../../hooks-plugin";

const dir = mkdtempSync(join(tmpdir(), "vb-route-docs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a route's answer is typed from the value its handler writes, and a superuser's guard is noticed", async () => {
  writeFileSync(join(dir, "stats.pb.js"), `
routerAdd("GET", "/api/vault-stats", (e) => {
  return e.json(200, { total: 0 })
})
routerAdd("POST", "/api/vaults/{id}/share", (e) => e.json(201, { shared: true, with: ["a"], note: null, by: { id: "x" } }), $apis.requireSuperuserAuth())
routerAdd("GET", "/api/computed", (e) => e.json(200, someValue()))
`);
  const code = compileHooksDir(dir);
  const docs = JSON.parse(/^export const routeDocs = (.*);$/m.exec(code)![1]!);
  expect(docs).toEqual([
    { method: "GET", path: "/api/vault-stats", superuser: false, response: { type: "object", properties: { total: { type: "number" } }, required: ["total"] } },
    { method: "POST", path: "/api/vaults/{id}/share", superuser: true, response: { type: "object", properties: { shared: { type: "boolean" }, with: { type: "array", items: { type: "string" } }, note: { type: "null" }, by: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, required: ["shared", "with", "note", "by"] } },
    { method: "GET", path: "/api/computed", superuser: false, response: {} },
  ]);
});
