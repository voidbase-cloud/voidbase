// Realtime fan-out check: opens N SSE clients, subscribes each to a collection, creates one record and measures how
// many clients receive the event and how long it takes (the poll loop targets about one second).
//   bun scripts/bench-realtime.ts [url=http://127.0.0.1:5180] [clients=100]
const url = (process.argv[2] ?? "http://127.0.0.1:5180").replace(/\/$/, ""); const N = Number(process.argv[3] ?? 100);
const su = await fetch(`${url}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com", password: process.env.VOIDBASE_SUPERUSER_PASSWORD ?? "changeme123" }) }).then((r) => r.json()) as { token: string };
const H = { authorization: su.token, "content-type": "application/json" };
await fetch(`${url}/api/collections/ks_rt`, { method: "DELETE", headers: H });
await fetch(`${url}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "ks_rt", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text" }] }) });
interface Client { id: string; ac: AbortController; received: number[] }
const clients: Client[] = []; let sent = 0;
async function open(): Promise<Client> {
  const ac = new AbortController(); const res = await fetch(`${url}/api/realtime`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  const client: Client = { id: "", ac, received: [] };
  const connected = new Promise<void>((resolve) => {
    (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true })); if (done) break;
        buf += dec.decode(value, { stream: true }); let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2); let ev = "message", data = "";
          for (const line of chunk.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
          if (ev === "PB_CONNECT") { client.id = (JSON.parse(data) as { clientId: string }).clientId; resolve(); }
          else if (ev === "ks_rt/*") client.received.push(performance.now() - sent);
        }
      }
    })();
  });
  await connected;
  const sub = await fetch(`${url}/api/realtime`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: client.id, subscriptions: ["ks_rt/*"] }) });
  if (sub.status !== 204) throw new Error(`subscribe failed: ${sub.status}`);
  return client;
}
const t0 = performance.now();
const BATCH = 25;
for (let i = 0; i < N; i += BATCH) clients.push(...(await Promise.all(Array.from({ length: Math.min(BATCH, N - i) }, open))));
const openMs = performance.now() - t0;
sent = performance.now();
await fetch(`${url}/api/collections/ks_rt/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "ping" }) });
await new Promise((r) => setTimeout(r, 5000));
const got = clients.filter((c) => c.received.length > 0); const lat = got.map((c) => c.received[0]!).sort((a, b) => a - b);
const pct = (p: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]!.toFixed(0) : "-";
console.log(`clients: ${N} opened+subscribed in ${(openMs / 1000).toFixed(1)}s; event received by ${got.length}/${N}; delivery latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms`);
for (const c of clients) c.ac.abort();
await fetch(`${url}/api/collections/ks_rt`, { method: "DELETE", headers: H });
process.exit(0);
