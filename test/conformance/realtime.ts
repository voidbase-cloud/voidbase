// Realtime smoke: open the PocketBase SSE protocol against voidbase, subscribe, write, expect the event.
//   bun test/conformance/realtime.ts [--vb http://127.0.0.1:5180]
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const VB = args.vb ?? "http://127.0.0.1:5180";
const login = await fetch(`${VB}/api/collections/users/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "user@example.com", password: "changeme123" }) });
const { token, record: user } = (await login.json()) as { token: string; record: { id: string } };

const ac = new AbortController();
const res = await fetch(`${VB}/api/realtime`, { headers: { Authorization: token, Accept: "text/event-stream" }, signal: ac.signal });
console.log("SSE status:", res.status, res.headers.get("content-type"));
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = "";
const events: { event: string; id?: string; data: string }[] = [];
const waiters: ((e: { event: string; id?: string; data: string }) => void)[] = [];
void (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const e: { event: string; id?: string; data: string } = { event: "message", data: "" };
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) e.event = line.slice(6).trim();
        else if (line.startsWith("id:")) e.id = line.slice(3).trim();
        else if (line.startsWith("data:")) e.data += line.slice(5).trim();
      }
      if (frame.trim().startsWith(":")) continue;
      events.push(e);
      waiters.splice(0).forEach((w) => w(e));
    }
  }
})();
const waitFor = (pred: (e: { event: string; data: string }) => boolean, ms = 6000) => new Promise<{ event: string; id?: string; data: string } | null>((resolve) => {
  const hit = events.find(pred); if (hit) return resolve(hit);
  const t = setTimeout(() => resolve(null), ms);
  const w = (e: { event: string; id?: string; data: string }) => { if (pred(e)) { clearTimeout(t); resolve(e); } else waiters.push(w); };
  waiters.push(w);
});

const connect = await waitFor((e) => e.event === "PB_CONNECT");
const clientId = connect ? (JSON.parse(connect.data) as { clientId: string }).clientId : "";
console.log("PB_CONNECT:", !!connect, "id matches data:", connect?.id === clientId, "clientId length:", clientId.length);
const sub = await fetch(`${VB}/api/realtime`, { method: "POST", headers: { Authorization: token, "content-type": "application/json" }, body: JSON.stringify({ clientId, subscriptions: ["posts/*"] }) });
console.log("subscribe:", sub.status);
const t0 = Date.now();
const created = await fetch(`${VB}/api/collections/posts/records`, { method: "POST", headers: { Authorization: token, "content-type": "application/json" }, body: JSON.stringify({ title: "Realtime post", body: "live", user: user.id }) });
const post = (await created.json()) as { id: string };
const ev = await waitFor((e) => e.event === "posts/*" && e.data.includes(post.id));
const data = ev ? (JSON.parse(ev.data) as { action: string; record: { id: string; title: string } }) : null;
console.log("create event:", data?.action, data?.record.title, `after ${Date.now() - t0}ms`);
await fetch(`${VB}/api/collections/posts/records/${post.id}`, { method: "DELETE", headers: { Authorization: token } });
const del = await waitFor((e) => e.event === "posts/*" && e.data.includes('"action":"delete"'));
console.log("delete event:", !!del, del ? (JSON.parse(del.data) as { record: { id: string } }).record.id === post.id : "");
const bad = await fetch(`${VB}/api/realtime`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "nope", subscriptions: [] }) });
console.log("unknown client:", bad.status, (await bad.json() as { message: string }).message);
ac.abort();
process.exit(connect && sub.status === 204 && data?.action === "create" && del ? 0 : 1);
