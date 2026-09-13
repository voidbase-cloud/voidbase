// Drift noticed on a schedule (src/server/rebuild/drift.ts): the deployed version's tag, which a rebuild writes with the
// hash of the declaration it built, compared with the declaration's hash now, against a fake Cloudflare deployments API.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { d1 } from "../../src/node/d1";
import { declarationHash, emptyDeclaration, readDeclaration, writeDeclaration } from "../../src/server/rebuild/declaration";
import { checkDrift } from "../../src/server/rebuild/drift";
import { readState } from "../../src/server/rebuild/run";

let tag: string | undefined = undefined;
const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  if (u.pathname === "/accounts/acc/workers/scripts/shop/deployments") return ok({ deployments: [{ versions: [{ version_id: "v-9", percentage: 100 }] }] });
  if (u.pathname === "/accounts/acc/workers/scripts/shop/versions/v-9") return ok({ annotations: tag ? { "workers/tag": tag } : {} });
  return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
} });
afterAll(() => api.stop(true));

test("the deployed version agrees with the declaration until the panel changes it, and a version no rebuild made is drift too", async () => {
  const env = { DB: d1(new Database(":memory:")), STORAGE: {} as R2Bucket, VOIDBASE_REBUILD_TOKEN: "t", VOIDBASE_ACCOUNT_ID: "acc", VOIDBASE_WORKER_NAME: "shop" };
  const opts = { api: `http://127.0.0.1:${api.port}`, now: () => new Date("2026-09-13T12:00:00Z") };
  const d = emptyDeclaration();
  d.plugins.hello = { version: "0.1.0", shape: "files", integrity: "sha256-x", marketplace: "m", source: { repository: "me/hello", commit: "1".repeat(40) }, installedOn: "2026-09-13" };
  await writeDeclaration(env.DB, d);
  const hash = await declarationHash(d);
  expect(hash).toMatch(/^[0-9a-f]{12}$/);

  tag = `rebuild-3-${hash}`;
  expect(await checkDrift(env, opts)).toEqual({ checkedAt: "2026-09-13T12:00:00.000Z", declared: hash, deployed: hash, drifted: false });

  // the panel installs something and no rebuild follows
  const changed = await readDeclaration(env.DB); changed.disabled.push("mail"); await writeDeclaration(env.DB, changed);
  const drift = await checkDrift(env, opts);
  expect(drift).toMatchObject({ deployed: hash, drifted: true, detail: `the deployed version (rebuild-3-${hash}) was built from another declaration` });
  expect((await readState(env.DB)).drift).toEqual(drift);

  // a version uploaded some other way carries no rebuild's tag
  tag = undefined;
  expect(await checkDrift(env, opts)).toMatchObject({ deployed: null, drifted: true, detail: "the deployed version was not uploaded by a rebuild" });

  // an instance without its token cannot read what it runs, and says so rather than guessing
  expect(await checkDrift({ ...env, VOIDBASE_REBUILD_TOKEN: undefined }, opts)).toMatchObject({ drifted: false, detail: expect.stringContaining("no rebuild token") });
});
