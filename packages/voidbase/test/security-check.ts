// `voidbase check --security <url>` end to end, against instances that answer crafted headers: the CLI runs as a
// child process, so the exit code, the printed lines and --json are all checked the way a pipeline would see them.
//
// Three instances stand in for the cases that matter: one with the whole response policy set (nothing fails), one
// answering the dangerous combination (Access-Control-Allow-Origin * together with Access-Control-Allow-Credentials,
// which lets any site read an authenticated answer), and the first again for --json. Every request the check makes
// is recorded, because the one thing it must never do is change the instance.
//   bun test/security-check.ts
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };

interface Instance { url: string; calls: string[]; stop(): void }
interface Shape {
  /** CORS as this instance answers an origin it has never heard of: a named list answers nothing */
  cors?: "named" | "wildcard";
  credentials?: boolean;
  /** the response policy's headers, all of them unless a case removes one */
  headers?: Record<string, string>;
  /** whether VOIDBASE_CSRF=double-submit is on, which is what GET /api/csrf answering means */
  csrf?: boolean;
  /** which GET /api/health this instance starts answering 429 on, so the rate-limit spot check sees one */
  limitAfter?: number;
  /** what a served file's Content-Security-Policy is */
  fileCsp?: string;
}

const FULL_POLICY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Xss-Protection": "1; mode=block",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'",
};
const STRICT_FILE_CSP = "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

function instance(shape: Shape): Instance {
  const calls: string[] = [];
  let health = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const url = new URL(req.url); const path = url.pathname; const method = req.method;
    calls.push(`${method} ${path}`);
    const headers = new Headers({ ...FULL_POLICY, ...(shape.headers ?? {}) });
    const origin = req.headers.get("origin");
    if (origin && shape.cors === "wildcard") headers.set("Access-Control-Allow-Origin", "*");
    if (origin && shape.credentials) headers.set("Access-Control-Allow-Credentials", "true");
    if (method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (path === "/api/csrf") {
      if (!shape.csrf) return Response.json({ message: "The requested resource wasn't found.", status: 404, data: {} }, { status: 404, headers });
      headers.set("Set-Cookie", "vb_csrf=iEZVc0hQTk9aWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo; Path=/; SameSite=Lax");
      headers.set("Cache-Control", "no-store");
      return Response.json({ token: "iEZVc0hQTk9aWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo" }, { headers });
    }
    if (path.startsWith("/api/files/")) {
      headers.set("Content-Security-Policy", shape.fileCsp ?? STRICT_FILE_CSP);
      headers.set("Content-Type", "image/png");
      return new Response("png", { headers });
    }
    if (path === "/api/health") {
      health++;
      if (shape.limitAfter && health >= shape.limitAfter) return Response.json({ message: "Too Many Requests.", status: 429, data: {} }, { status: 429, headers });
      return Response.json({ message: "API is healthy.", code: 200, data: {} }, { headers });
    }
    return Response.json({ message: "The requested resource wasn't found.", status: 404, data: {} }, { status: 404, headers });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", "bin/voidbase.ts", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

// ---- a clean instance: everything the policy can set, set ----------------------------------------------------
const clean = instance({ cors: "named", csrf: true, limitAfter: 5 });
{
  const r = await cli("check", "--security", clean.url, "--file", "/api/files/posts/1/a.png");
  const line = (name: string) => (r.out.split("\n").find((l) => l.includes(`  ${name} `) || l.includes(`  ${name}  `)) ?? "").trim();
  check("a clean instance exits 0 and fails nothing", r.code === 0 && /0 fail\./.test(r.out), r.out.slice(-800));
  check("the headers the policy sets each pass", ["x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin", "csp"].every((n) => line(n).startsWith("pass")), r.out);
  check("the files' policy passes when --file shows default-src 'none'", line("csp-files").startsWith("pass") && line("csp-files").includes("default-src 'none'"), line("csp-files"));
  check("a named CORS list passes: an unlisted origin got no CORS headers", line("cors").startsWith("pass"), line("cors"));
  check("the cookie the token route sets passes with SameSite on http", line("cookies").startsWith("pass") && line("cookies").includes("vb_csrf"), line("cookies"));
  check("the rate limit answered the burst, and the output says it is a spot check", line("rate-limit").startsWith("pass") && /spot check, not proof/.test(r.out), line("rate-limit"));
  check("/api/health leaks nothing to a stranger", line("health").startsWith("pass"), line("health"));
  check("the CSRF rule is reported on, because GET /api/csrf answered a token", line("csrf").startsWith("pass") && /double-submit/.test(line("csrf")), line("csrf"));
  check("hsts warns rather than fails on an http instance", line("hsts").startsWith("warn"), line("hsts"));
  check("nothing it sent could change the instance: GET and OPTIONS only", clean.calls.every((c) => c.startsWith("GET ") || c.startsWith("OPTIONS ")), clean.calls.join(", "));
  check("the burst stays well under anything that looks like an attack", clean.calls.filter((c) => c === "GET /api/health").length <= 21, String(clean.calls.length));
}

// ---- the dangerous combination: a wildcard origin that also allows credentials --------------------------------
{
  const open = instance({ cors: "wildcard", credentials: true, limitAfter: 5 });
  const r = await cli("check", "--security", open.url);
  const lines = r.out.split("\n");
  const at = lines.findIndex((l) => l.includes(" cors "));
  const cors = (lines[at] ?? "").trim();
  check("a wildcard origin allowing credentials fails, and the command exits 1", r.code === 1 && cors.startsWith("fail"), `${r.code}: ${cors}`);
  check("the failing line carries the fix on the line under it", /VOIDBASE_CORS_ORIGINS/.test(lines[at + 1] ?? ""), lines[at + 1] ?? "");
  check("the summary counts the failure", /1 fail\./.test(r.out), r.out.slice(-300));
  open.stop();
}

// ---- a missing header fails rather than warns -----------------------------------------------------------------
{
  const bare = instance({ cors: "named", headers: { "X-Content-Type-Options": "" }, limitAfter: 5 });
  const r = await cli("check", "--security", bare.url);
  check("no X-Content-Type-Options is a failure: the plugin is not running", r.code === 1 && /^fail\s+x-content-type-options/m.test(r.out), r.out.slice(0, 600));
  bare.stop();
}

// ---- --json prints the same as data ---------------------------------------------------------------------------
{
  const r = await cli("check", "--security", clean.url, "--json");
  let doc: { url: string; https: boolean; pass: number; warn: number; fail: number; lines: { name: string; verdict: string; detail: string; fix: string }[] } | null = null;
  try { doc = JSON.parse(r.out); } catch { /* reported below */ }
  check("--json prints one parsable document and exits 0", r.code === 0 && !!doc, r.out.slice(0, 400));
  check("it carries a line per check, each with a verdict and a fix", !!doc && doc.lines.length >= 11 && doc.lines.every((l) => ["pass", "warn", "fail"].includes(l.verdict) && !!l.fix), JSON.stringify(doc?.lines?.slice(0, 2)));
  check("the counts add up and the url is the one asked for", !!doc && doc.pass + doc.warn + doc.fail === doc.lines.length && doc.url === clean.url && doc.https === false, JSON.stringify({ pass: doc?.pass, warn: doc?.warn, fail: doc?.fail }));
  check("the names are stable, so a pipeline may grep for one", !!doc && ["cors", "csrf", "rate-limit", "csp", "csp-files", "cookies", "health", "hsts"].every((n) => doc!.lines.some((l) => l.name === n)), JSON.stringify(doc?.lines.map((l) => l.name)));
}
clean.stop();

// ---- an instance that is not there ----------------------------------------------------------------------------
{
  const r = await cli("check", "--security", "not-a-url");
  check("a bad url is refused before any request, with the reason", r.code === 1 && /is not a URL/.test(r.out), r.out.slice(0, 200));
  const usage = await cli("check");
  check("check without --security prints the usage and exits 1", usage.code === 1 && /--security <url>/.test(usage.out), usage.out.slice(0, 200));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
