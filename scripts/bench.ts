// Latency and throughput baseline per endpoint against a running voidbase (or PocketBase): sequential p50/p95 and a
// concurrent burst. Numbers from a local dev server (miniflare) are not production numbers; see docs/perf.md.
//   bun scripts/bench.ts [url=http://127.0.0.1:5180] [--n 30] [--concurrency 10]
const args = process.argv.slice(2); const url = (args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:5180").replace(/\/$/, "");
const opt = (k: string, d: number) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const N = opt("n", 30), C = opt("concurrency", 10);
const su = await fetch(`${url}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com", password: process.env.VOIDBASE_SUPERUSER_PASSWORD ?? "changeme123" }) }).then((r) => r.json()) as { token: string };
const H = { authorization: su.token, "content-type": "application/json" };
await fetch(`${url}/api/collections/ks_bench`, { method: "DELETE", headers: H });
await fetch(`${url}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "ks_bench", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text" }, { name: "n", type: "number" }, { name: "pic", type: "file", maxSelect: 1, thumbs: ["100x100"] }] }) });
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8AAQv8ZYAwAQ84H+VjtZqAAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const fd = new FormData(); fd.append("title", "seed"); fd.append("pic", new Blob([png], { type: "image/png" }), "dot.png");
const seeded = (await fetch(`${url}/api/collections/ks_bench/records`, { method: "POST", headers: { authorization: su.token }, body: fd }).then((r) => r.json())) as { id: string; pic: string };
for (let i = 0; i < 50; i++) await fetch(`${url}/api/collections/ks_bench/records`, { method: "POST", headers: H, body: JSON.stringify({ title: `row ${i}`, n: i }) });
const created: string[] = [];
const cases: { name: string; run: () => Promise<Response> }[] = [
  { name: "GET /api/health", run: () => fetch(`${url}/api/health`) },
  { name: "GET records list (30)", run: () => fetch(`${url}/api/collections/ks_bench/records?perPage=30`) },
  { name: "GET records list + filter + sort", run: () => fetch(`${url}/api/collections/ks_bench/records?perPage=30&filter=${encodeURIComponent("n > 10 && title ~ 'row'")}&sort=-n`) },
  { name: "GET record view", run: () => fetch(`${url}/api/collections/ks_bench/records/${seeded.id}`) },
  { name: "POST record create", run: async () => { const r = await fetch(`${url}/api/collections/ks_bench/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "bench", n: 1 }) }); created.push(String(((await r.clone().json()) as { id: string }).id)); return r; } },
  { name: "PATCH record update", run: () => fetch(`${url}/api/collections/ks_bench/records/${seeded.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ n: Math.random() }) }) },
  { name: "POST auth-with-password", run: () => fetch(`${url}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) }) },
  { name: "GET file", run: () => fetch(`${url}/api/files/ks_bench/${seeded.id}/${seeded.pic}`) },
  { name: "GET thumb 100x100 (cached after first)", run: () => fetch(`${url}/api/files/ks_bench/${seeded.id}/${seeded.pic}?thumb=100x100`) },
  { name: "GET collections list (superuser)", run: () => fetch(`${url}/api/collections`, { headers: H }) },
];
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
console.log(`voidbase bench against ${url}: ${N} sequential requests, then ${C}x${N} concurrent, per endpoint\n`);
console.log("| endpoint | p50 ms | p95 ms | max ms | concurrent req/s | errors |\n| --- | ---: | ---: | ---: | ---: | ---: |");
for (const c of cases) {
  const lat: number[] = []; let errors = 0;
  for (let i = 0; i < N; i++) { const t = performance.now(); const r = await c.run(); await r.arrayBuffer(); lat.push(performance.now() - t); if (r.status >= 400) errors++; }
  const t0 = performance.now();
  await Promise.all(Array.from({ length: C }, async () => { for (let i = 0; i < N; i++) { const r = await c.run(); await r.arrayBuffer(); if (r.status >= 400) errors++; } }));
  const rps = (C * N) / ((performance.now() - t0) / 1000);
  console.log(`| ${c.name} | ${pct(lat, 0.5).toFixed(1)} | ${pct(lat, 0.95).toFixed(1)} | ${Math.max(...lat).toFixed(1)} | ${rps.toFixed(0)} | ${errors} |`);
}
await fetch(`${url}/api/collections/ks_bench`, { method: "DELETE", headers: H });
