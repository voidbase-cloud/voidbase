// In-memory Cloudflare REST API (the endpoints `voidbase deploy` uses) with a fixed bearer token, for dry-run tests.
//   bun test/cf-mock.ts [port=5197]      token: cf-test-token   account: acc123
// A second token, cf-test-token-noqueues, is accepted everywhere except the Queues endpoints (a token without Queues edit).
const port = Number(process.argv[2] ?? 5197); const TOKEN = "cf-test-token"; const TOKEN_NOQUEUES = "cf-test-token-noqueues"; const ACCOUNT = "acc123";
const d1 = new Map<string, string>(); const r2 = new Set<string>(); const queues = new Map<string, string>(); const calls: string[] = [];
const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
const err = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
Bun.serve({ port, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url); const p = url.pathname;
  if (p === "/__calls") { if (req.method === "DELETE") { calls.length = 0; d1.clear(); r2.clear(); queues.clear(); return new Response(null, { status: 204 }); } return Response.json(calls); }
  calls.push(`${req.method} ${p}${url.search}`);
  const bearer = req.headers.get("authorization");
  if (bearer !== `Bearer ${TOKEN}` && bearer !== `Bearer ${TOKEN_NOQUEUES}`) return err(400, 10000, "Authentication error");
  if (p.startsWith(`/accounts/${ACCOUNT}/queues`)) {
    if (bearer === `Bearer ${TOKEN_NOQUEUES}`) return err(403, 10000, "Authentication error: the token lacks Queues permissions");
    if (req.method === "GET") return ok([...queues.entries()].map(([queue_name, queue_id]) => ({ queue_name, queue_id })));
    if (req.method === "POST") { const { queue_name } = (await req.json()) as { queue_name: string }; if (queues.has(queue_name)) return err(400, 11009, "queue already exists"); const id = crypto.randomUUID().replace(/-/g, ""); queues.set(queue_name, id); return ok({ queue_name, queue_id: id }); }
  }
  if (p === "/accounts") return ok([{ id: ACCOUNT, name: "Test Account" }]);
  if (p === `/accounts/${ACCOUNT}/d1/database` && req.method === "GET") { const name = url.searchParams.get("name"); return ok([...d1.entries()].filter(([n]) => !name || n === name).map(([n, uuid]) => ({ name: n, uuid, version: "production" }))); }
  if (p === `/accounts/${ACCOUNT}/d1/database` && req.method === "POST") { const { name } = (await req.json()) as { name: string }; if (d1.has(name)) return err(400, 7502, "already exists"); const uuid = crypto.randomUUID(); d1.set(name, uuid); return ok({ name, uuid }); }
  if (p.startsWith(`/accounts/${ACCOUNT}/r2/buckets/`)) { const name = decodeURIComponent(p.split("/").pop()!); return r2.has(name) ? ok({ name }) : err(404, 10006, "bucket not found"); }
  if (p === `/accounts/${ACCOUNT}/r2/buckets` && req.method === "POST") { const { name } = (await req.json()) as { name: string }; r2.add(name); return ok({ name }); }
  if (p === `/accounts/${ACCOUNT}/workers/subdomain`) return ok({ subdomain: "testsub" });
  return err(404, 7000, `no route for ${req.method} ${p}`);
} });
console.log(`cloudflare api mock on http://127.0.0.1:${port} (token ${TOKEN}, account ${ACCOUNT})`);
