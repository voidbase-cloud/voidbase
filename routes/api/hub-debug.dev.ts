// dev-only: which realtime transport this Worker has, the hub's socket count, and a synthetic publish
import { defineHandler } from "void";
import { hubActive, publishChanges } from "../../src/server/realtime/hub-client";
export const GET = defineHandler(async (c) => {
  const env = c.env as unknown as { HUB?: DurableObjectNamespace };
  if (!env.HUB) return c.json({ hub: false, active: hubActive() });
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  const stats = await stub.fetch("https://hub/stats").then((r) => r.json());
  const collection = new URL(c.req.url).searchParams.get("publish");
  let delivered: unknown = null;
  if (collection) { const r = await stub.fetch("https://hub/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [{ collection, recordId: "x", action: "update" }] }) }); delivered = await r.json(); }
  const staleMs = new URL(c.req.url).searchParams.get("sweep");
  if (staleMs !== null) { const r = await stub.fetch("https://hub/sweep", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ staleMs: Number(staleMs) }) }); delivered = await r.json(); }
  if (new URL(c.req.url).searchParams.get("via") === "client") { await publishChanges([{ collection: "ks_hub", recordId: "y", action: "update" }]); delivered = "via publishChanges"; }
  return c.json({ hub: true, active: hubActive(), stats, delivered });
});
