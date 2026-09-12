// `voidbase types --watch` end to end, against a fake instance served here: the sign-in and GET /api/openapi.json,
// with a document this file changes between polls. The CLI runs as a child process (its stdout read as it comes) with
// --env-file pointing at an empty file, so the checkout's own .env cannot sign it in, and VOIDBASE_TYPES_WATCH_INTERVAL_MS
// set, which is the test-only knob that lets a poll happen faster than the one-second floor --interval allows.
//   bun test/types-watch.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };

// ---- the fake instance: a superuser sign-in and a document that changes -----------------------------------------
// Only what the generator reads is here: one schema per collection whose collectionName enum names it. The real
// document is built by src/server/plugins/openapi.ts and checked against the generator in test/unit/typed-client.test.ts;
// what matters for a watch is that the document changes between polls.
const EMAIL = "watch@example.com", PASSWORD = "watch-password";
let collections: Record<string, string[]> = { posts: ["title"], users: ["name"] };
let failing = false, signIns = 0, token = "";
const document = () => ({
  openapi: "3.1.0",
  info: { title: "Watched", version: "0.9.0", "x-voidbase": { scope: "superuser", collection: "_superusers" } },
  paths: {},
  components: { schemas: Object.fromEntries(Object.entries(collections).map(([name, fields]) => [name, {
    type: "object",
    properties: { id: { type: "string" }, collectionId: { type: "string" }, collectionName: { enum: [name] }, ...Object.fromEntries(fields.map((f) => [f, { type: "string" }])) },
    required: ["id", "collectionId", "collectionName", ...fields],
  }])) },
});
const instance = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/api/collections/_superusers/auth-with-password") {
    const b = (await req.json()) as { identity: string; password: string };
    if (b.identity !== EMAIL || b.password !== PASSWORD) return Response.json({ message: "Failed to authenticate." }, { status: 400 });
    token = `tok-${++signIns}`; // only the newest token is accepted: minting one expires the one the child holds
    return Response.json({ token });
  }
  if (p === "/api/openapi.json") {
    if (failing) return Response.json({ message: "the instance is restarting" }, { status: 503 });
    if ((req.headers.get("authorization") ?? "") !== token) return Response.json({ message: "The request requires valid record authorization token." }, { status: 401 });
    return Response.json(document());
  }
  return Response.json({ message: `no route for ${p}` }, { status: 404 });
} });
const INSTANCE = `http://127.0.0.1:${instance.port}`;
const mintToken = async () => String(((await (await fetch(`${INSTANCE}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: EMAIL, password: PASSWORD }) })).json()) as { token: string }).token);

// ---- the CLI as a child process ---------------------------------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), "vb-types-watch-"));
const OUT = join(home, "src", "voidbase.ts");
const noEnv = join(home, "empty.env"); writeFileSync(noEnv, "");
const SAVED = join(home, "openapi.json"); writeFileSync(SAVED, JSON.stringify(document()));
const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: home, VOIDBASE_TYPES_WATCH_INTERVAL_MS: "150", VOIDBASE_URL: undefined, VOIDBASE_SUPERUSER_EMAIL: undefined, VOIDBASE_SUPERUSER_PASSWORD: undefined };
const spawn = (...args: string[]) => Bun.spawn(["bun", `--env-file=${noEnv}`, resolve(ROOT, "bin/voidbase.ts"), "types", ...args], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
/** a run that ends on its own */
async function once(...args: string[]): Promise<{ code: number; all: string }> {
  const p = spawn(...args);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, all: out + err };
}
/** a watch, with its output read as it arrives */
function watcher(...args: string[]) {
  const p = spawn("--watch", ...args);
  let text = "";
  const drain = async (s: ReadableStream<Uint8Array>) => { const r = s.getReader(); const d = new TextDecoder(); for (;;) { const { done, value } = await r.read(); if (done) break; text += d.decode(value, { stream: true }); } };
  void drain(p.stdout); void drain(p.stderr);
  const seen = () => text;
  const waitFor = async (re: RegExp, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = text.match(re); if (m) return m[0]; await Bun.sleep(25); } return null; };
  return { p, seen, waitFor };
}
const mtime = () => { try { return statSync(OUT).mtimeMs; } catch { return 0; } };

try {
  // ---- the long watch: the first write, a quiet poll, a change, a failure, an expired token ----------------------
  const w = watcher("--url", INSTANCE, "--email", EMAIL, "--password", PASSWORD, "--out", OUT, "--interval", "1");
  const first = await w.waitFor(/wrote .*voidbase\.ts: 2 collections from http/);
  const written = mtime() ? readFileSync(OUT, "utf8") : "";
  check("the file is written once at start, with an interface per collection", !!first && /export interface PostsRecord/.test(written) && /export interface UsersRecord/.test(written) && /posts: PostsRecord;/.test(written) && /watching http.*every 0\.2s/.test(w.seen()), `${first} ${w.seen().slice(0, 300)}`);

  const quiet = mtime();
  await Bun.sleep(900); // six polls of the same document
  check("an unchanged poll rewrites nothing and prints nothing", mtime() === quiet && !/rewrote/.test(w.seen()) && w.p.exitCode === null, w.seen().slice(0, 400));

  collections = { posts: ["title", "subtitle"], users: ["name"] };
  const gained = await w.waitFor(/rewrote .*voidbase\.ts: .*/);
  check("a collection that gains a field is rewritten, and the line names the collection and the field", !!gained && /changed posts \(\+subtitle\)/.test(gained ?? "") && mtime() !== quiet && /subtitle/.test(readFileSync(OUT, "utf8")), `${gained} ${w.seen().slice(0, 400)}`);

  collections = { posts: ["title", "subtitle"], comments: ["body"] };
  const moved = await w.waitFor(/rewrote .*voidbase\.ts: added comments.*/);
  check("a collection added and one removed are both named in the one line", !!moved && /added comments/.test(moved ?? "") && /removed users/.test(moved ?? "") && /export interface CommentsRecord/.test(readFileSync(OUT, "utf8")) && !/export interface UsersRecord/.test(readFileSync(OUT, "utf8")), `${moved} ${w.seen().slice(0, 400)}`);

  failing = true;
  const failed = await w.waitFor(/poll of http.* failed: .*503/);
  const after = w.seen();
  await Bun.sleep(700); // more failed polls, which say nothing more
  const repeats = (w.seen().match(/poll of http/g) ?? []).length;
  failing = false;
  const back = await w.waitFor(/is answering again/, 8000);
  check("a failed poll is reported once, retried with a backoff, and the watch never exits", !!failed && repeats === 1 && w.p.exitCode === null && !!back, `${failed} repeats=${repeats} back=${back} ${after.slice(-300)}`);

  const before = signIns;
  await mintToken(); // the token the child holds is no longer the newest: its next poll is answered 401
  collections = { posts: ["title", "subtitle", "byline"], comments: ["body"] };
  const renewed = await w.waitFor(/rewrote .*voidbase\.ts: changed posts \(\+byline\)/, 8000);
  check("a 401 on a poll signs in again when the command has credentials, and the watch carries on", !!renewed && signIns === before + 2, `${renewed} signIns ${before} -> ${signIns}`);

  w.p.kill("SIGINT");
  const code = await w.p.exited;
  await Bun.sleep(100);
  check("Ctrl-C exits 0 and says how many times it rewrote", code === 0 && /rewritten 3 times/.test(w.seen()), `${code} ${w.seen().slice(-300)}`);

  // ---- what is refused ------------------------------------------------------------------------------------------
  const withJson = await once("--watch", "--json", SAVED, "--out", OUT);
  check("--watch with --json is refused: a saved document is not something to poll", withJson.code === 1 && /nothing to poll/.test(withJson.all), `${withJson.code} ${withJson.all}`);
  const tooFast = await once("--watch", "--url", INSTANCE, "--email", EMAIL, "--password", PASSWORD, "--interval", "0.5", "--out", OUT);
  check("--interval under a second is refused", tooFast.code === 1 && /cannot be under 1/.test(tooFast.all), `${tooFast.code} ${tooFast.all}`);
  const noWatch = await once("--url", INSTANCE, "--interval", "5", "--out", OUT);
  check("--interval without --watch is refused rather than ignored", noWatch.code === 1 && /add --watch/.test(noWatch.all), `${noWatch.code} ${noWatch.all}`);

  // ---- a raw token cannot be renewed ----------------------------------------------------------------------------
  const settled = mtime();
  const raw = watcher("--url", INSTANCE, "--token", await mintToken(), "--out", OUT, "--interval", "1");
  const rawFirst = await raw.waitFor(/voidbase\.ts is already what http.* describes: 2 collections/);
  check("a watch whose file is already what the instance describes touches nothing at start", !!rawFirst && mtime() === settled, `${rawFirst} ${raw.seen().slice(0, 300)}`);
  await mintToken(); // expire it
  const rawCode = await raw.p.exited;
  await Bun.sleep(100);
  check("a watch given --token stops when the token expires: it says so and exits 1", rawCode === 1 && /no longer accepts the token \(401\)/.test(raw.seen()), `${rawCode} ${raw.seen().slice(-300)}`);
} finally { instance.stop(true); rmSync(home, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
