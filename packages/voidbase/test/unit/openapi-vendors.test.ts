// Several vendors on one instance, each with rules that give them their own slice: the openapi document each vendor
// fetches from the same route describes their slice and nothing else (voidbase-stories b-binary-extended.feature: "A
// vendor fetching their own schema"). One instance on bun:sqlite with real collections and rules, so what decides is
// the rule engine.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { d1 } from "../../src/node/d1";
import { provideAuthLookup } from "../../src/server/auth-slot";
import { insertCollection } from "../../src/server/bootstrap";
import { invalidateCollections, loadCollections } from "../../src/server/collections/model";
import { createCollection } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { decideRule } from "../../src/server/filter/decide";
import { createKernel, load } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { openapiWith } from "../../src/server/plugins/openapi";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");

async function instance() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  }
  const db = d1(sqlite);
  invalidateCollections();
  for (const c of systemCollections()) await insertCollection(db, c);
  const vendors = await createCollection(db, { name: "vendors", type: "auth", listRule: "id = @request.auth.id", viewRule: "id = @request.auth.id", fields: [{ name: "vendor", type: "text" }] });
  for (const v of ["acme", "globex"]) {
    await createCollection(db, { name: `${v}_orders`, type: "base", listRule: `@request.auth.vendor = "${v}"`, viewRule: `@request.auth.vendor = "${v}"`, createRule: `@request.auth.vendor = "${v}"`, updateRule: `@request.auth.vendor = "${v}" && total >= 0`, deleteRule: null, fields: [{ name: "total", type: "number" }] });
  }
  await createCollection(db, { name: "catalog", type: "base", listRule: '@request.auth.id != ""', viewRule: '@request.auth.id != ""', fields: [{ name: "title", type: "text" }, { name: "seller", type: "relation", collectionId: vendors.id, maxSelect: 1 }] });
  await createCollection(db, { name: "pricing", type: "base", listRule: "seller = @request.auth.id", viewRule: '@request.body.title != ""', fields: [{ name: "title", type: "text" }, { name: "seller", type: "relation", collectionId: vendors.id, maxSelect: 1 }] });
  sqlite.run("INSERT INTO vendors (id, password, tokenKey, email, vendor) VALUES ('v1', 'h', 'tk1', 'acme@example.com', 'acme')");
  sqlite.run("INSERT INTO vendors (id, password, tokenKey, email, vendor) VALUES ('v2', 'h', 'tk2', 'globex@example.com', 'globex')");
  const collections = await loadCollections(db);
  const as = (id: string, vendor: string) => ({ collection: collections.get("vendors")!, row: { id, vendor } }) as AuthRecord;
  return { db, collections, acme: as("v1", "acme"), globex: as("v2", "globex"), superuser: { collection: collections.get("_superusers")!, row: { id: "s1" } } as AuthRecord };
}

describe("a rule decided for a caller before any record is in question", () => {
  test("a rule that reads only who is asking is decided; one that reads a record, another collection or the call is per record", async () => {
    const { db, collections, acme, globex } = await instance();
    const decide = (name: string, rule: string | null, who: AuthRecord | null) => decideRule({ db, collections, collection: collections.get(name)!, rule, auth: who });
    expect(await decide("acme_orders", '@request.auth.vendor = "acme"', acme)).toBe("yes");
    expect(await decide("acme_orders", '@request.auth.vendor = "acme"', globex)).toBe("no");
    expect(await decide("acme_orders", '@request.auth.vendor = "acme"', null)).toBe("no");
    expect(await decide("catalog", '@request.auth.id != ""', globex)).toBe("yes");
    expect(await decide("catalog", '@request.auth.id != ""', null)).toBe("no");
    expect(await decide("catalog", '@request.auth.vendor = "acme" || @request.auth.vendor = "globex"', globex)).toBe("yes");
    expect(await decide("catalog", "", null)).toBe("yes");
    expect(await decide("catalog", null, acme)).toBe("no");
    expect(await decide("acme_orders", '@request.auth.vendor = "acme" && total >= 0', acme)).toBe("per-record");
    // a part that is decided for the caller decides the whole when the other part cannot change it
    expect(await decide("acme_orders", '@request.auth.vendor = "acme" && total >= 0', globex)).toBe("no");
    expect(await decide("acme_orders", 'total >= 0 || @request.auth.vendor = "globex"', globex)).toBe("yes");
    expect(await decide("acme_orders", 'total >= 0 || @request.auth.vendor = "acme"', globex)).toBe("per-record");
    expect(await decide("pricing", "seller = @request.auth.id", acme)).toBe("per-record");
    expect(await decide("pricing", '@request.body.title != ""', acme)).toBe("per-record");
    expect(await decide("pricing", '@collection.catalog.title != ""', acme)).toBe("per-record");
    expect(await decide("pricing", "not a (rule", acme)).toBe("per-record");
  });
});

describe("each vendor's document is their slice", () => {
  async function documents() {
    const inst = await instance();
    const app = new Hono<AppEnv>();
    const who: Record<string, AuthRecord | null> = { acme: inst.acme, globex: inst.globex, superuser: inst.superuser, anonymous: null };
    app.use("*", async (c, next) => { c.set("auth", who[c.req.header("x-as") ?? "anonymous"] ?? null); await next(); });
    const kernel = createKernel(app);
    await load(kernel, [auth, openapiWith({ collections: async (env) => [...(await loadCollections(env.DB)).values()], appName: async () => "Market" })], "0.9.0");
    provideAuthLookup(() => provider);
    return async (as: string) => {
      const r = await app.request("http://market.example/api/openapi.json", { headers: { "x-as": as } }, { DB: inst.db } as Bindings);
      expect(r.status).toBe(200);
      const doc = (await r.json()) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
      return { doc, reach: (name: string) => Object.keys(doc.paths).filter((p) => p.startsWith(`/api/collections/${name}/records`)).flatMap((p) => Object.keys(doc.paths[p]!).map((m) => `${m} ${p.slice(`/api/collections/${name}/records`.length) || "/"}`)).sort() };
    };
  }

  test("a vendor fetching the same route receives only the slice their rules allow", async () => {
    const doc = await documents();
    const acme = await doc("acme");
    expect(acme.reach("acme_orders")).toEqual(["get /", "get /{id}", "get /{id}/can-update", "patch /{id}", "post /"]);
    expect(acme.reach("globex_orders")).toEqual([]);
    expect(acme.doc.components.schemas.globex_orders).toBeUndefined();
    const globex = await doc("globex");
    expect(globex.reach("globex_orders")).toEqual(["get /", "get /{id}", "get /{id}/can-update", "patch /{id}", "post /"]);
    expect(globex.reach("acme_orders")).toEqual([]);
    // what every signed-in vendor may reach is in both; a rule that reads the record is still shown to the signed in
    for (const d of [acme, globex]) { expect(d.reach("catalog")).toEqual(["get /", "get /{id}", "get /{id}/can-update"]); expect(d.reach("pricing")).toContain("get /"); }
  });

  test("nobody signed in sees no vendor's slice; a superuser sees them all", async () => {
    const doc = await documents();
    const anonymous = await doc("anonymous");
    for (const name of ["acme_orders", "globex_orders", "catalog", "pricing"]) expect(anonymous.reach(name)).toEqual([]);
    const superuser = await doc("superuser");
    expect(superuser.reach("acme_orders")).toContain("delete /{id}");
    expect(superuser.reach("globex_orders")).toContain("delete /{id}");
  });
});
