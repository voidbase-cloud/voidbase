// The CI status page: what a Workers Builds deploy of the CI Worker publishes after a build (docs/ci.md) and what
// GitHub Actions keeps as the `ci-status` artifact. scripts/ci-lib.sh records every step in .void/ci-steps.tsv;
// `render` turns the steps, the per-suite lines of scripts/ci-suites.sh, the screenshots and the logs into ci/public:
// index.html, status.json, badge.svg and logs/.
//   bun scripts/ci-status.ts render [--kind ci|release] [--out ci/public]
//   bun scripts/ci-status.ts placeholder [--out ci/public]     the page before any build ran (the first deploy)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Step { name: string; result: "ok" | "fail" | "skip"; seconds: number; log: string }
interface Suite { step: string; name: string; result: "PASS" | "FAIL"; detail: string }

const ROOT = resolve(import.meta.dir, "..");
const [cmd = "render", ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i]!.startsWith("--")) args[rest[i]!.slice(2)] = rest[i + 1] ?? "1", i++;
const out = resolve(ROOT, args.out ?? "ci/public");
const kind = args.kind ?? "ci";
const git = (a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: ROOT, stdout: "pipe", stderr: "ignore" }); return r.exitCode === 0 ? r.stdout.toString().trim() : ""; };
const env = process.env;
const backend = env.CI_BACKEND_NAME ?? (env.WORKERS_CI_BUILD_UUID ? "cloudflare" : env.GITHUB_ACTIONS ? "github" : "local");
const meta = {
  kind,
  title: kind === "release" ? "voidbase release" : "voidbase CI",
  repository: env.GITHUB_REPOSITORY ?? "voidbase-cloud/voidbase",
  commit: env.WORKERS_CI_COMMIT_SHA ?? env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]),
  subject: git(["log", "-1", "--format=%s"]),
  branch: env.WORKERS_CI_BRANCH ?? env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME ?? git(["rev-parse", "--abbrev-ref", "HEAD"]),
  backend,
  build: env.WORKERS_CI_BUILD_UUID ?? env.GITHUB_RUN_ID ?? "",
  finished: new Date().toISOString(),
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const badge = (label: string, value: string, color: string) => {
  const lw = Math.round(6.5 * label.length) + 12, vw = Math.round(6.5 * value.length) + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}"><rect width="${lw}" height="20" rx="3" fill="#555"/><rect x="${lw}" width="${vw}" height="20" rx="3" fill="${color}"/><rect x="${lw}" width="4" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${label}</text><text x="${lw + vw / 2}" y="14">${value}</text></g></svg>\n`;
};
const css = `:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1f2320;--muted:#6b7068;--line:#e3e1da;--ok:#1a7f4b;--fail:#b3261e;--skip:#8a8f88;--card:#ffffff}
@media (prefers-color-scheme: dark){:root{--bg:#161815;--fg:#e8e6df;--muted:#9a9e95;--line:#2c2f2a;--ok:#4cc38a;--fail:#ff7b72;--skip:#8a8f88;--card:#1e211d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:64rem;margin:0 auto;padding:2rem 1.25rem 4rem}h1{font-size:1.6rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:2rem 0 .5rem;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}
.state{display:inline-block;padding:.15rem .6rem;border-radius:.4rem;font-weight:600;color:#fff}.state.ok{background:var(--ok)}.state.fail{background:var(--fail)}.state.none{background:var(--skip)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:1rem 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:.5rem;overflow:hidden}th,td{text-align:left;padding:.45rem .7rem;border-top:1px solid var(--line);font-size:.9rem;vertical-align:top}th{border-top:0;color:var(--muted);font-weight:600;font-size:.8rem}
td.r{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}.ok{color:var(--ok)}.fail{color:var(--fail)}.skip{color:var(--skip)}a{color:inherit}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:1rem}.shots img{width:100%;border:1px solid var(--line);border-radius:.4rem;background:#fff}.shots figcaption{font-size:.8rem;color:var(--muted)}
details{margin:.5rem 0}summary{cursor:pointer;color:var(--muted)}`;

function readSteps(): Step[] {
  const f = resolve(ROOT, ".void/ci-steps.tsv");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { const [name, result, seconds, log] = l.split("\t"); return { name: name!, result: result as Step["result"], seconds: Number(seconds ?? 0), log: log ?? "" }; });
}
function readSuites(steps: Step[]): Suite[] {
  const suites: Suite[] = [];
  for (const s of steps) {
    if (!s.name.startsWith("suites") || !s.log || !existsSync(s.log)) continue;
    for (const line of readFileSync(s.log, "utf8").split("\n")) {
      const m = line.match(/^(PASS|FAIL)\s{2}(\S+)\s*(.*)$/);
      if (m) suites.push({ step: s.name, name: m[2]!, result: m[1] as Suite["result"], detail: m[3]!.trim() });
    }
  }
  return suites;
}
function page(body: string, state: "ok" | "fail" | "none", title: string) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><main>${body}</main></body></html>\n`;
}
function render() {
  const steps = readSteps(), suites = readSuites(steps);
  const ok = steps.length > 0 && steps.every((s) => s.result !== "fail");
  const total = steps.reduce((a, s) => a + s.seconds, 0);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const logsDir = resolve(ROOT, ".void/ci-logs");
  if (existsSync(logsDir)) cpSync(logsDir, resolve(out, "logs"), { recursive: true });
  const shots = existsSync(resolve(out, "logs")) ? readdirSync(resolve(out, "logs"), { recursive: true }).map(String).filter((f) => f.endsWith(".png")) : [];
  const status = { ...meta, ok, seconds: total, steps, suites: suites.map(({ step, name, result, detail }) => ({ step, name, result, detail })), screenshots: shots.map((f) => `logs/${f}`) };
  writeFileSync(resolve(out, "status.json"), JSON.stringify(status, null, 2) + "\n");
  writeFileSync(resolve(out, "badge.svg"), badge(kind === "release" ? "release" : "ci", ok ? "passing" : "failing", ok ? "#1a7f4b" : "#b3261e"));
  const commitUrl = `https://github.com/${meta.repository}/commit/${meta.commit}`;
  const logLink = (s: Step) => (s.log ? `<a href="logs/steps/${esc(s.name)}.log">log</a>` : "");
  const body = `<h1>${esc(meta.title)} <span class="state ${ok ? "ok" : "fail"}">${ok ? "passing" : "failing"}</span></h1>
<p>${esc(meta.subject)}</p>
<dl><dt>commit</dt><dd><a href="${commitUrl}">${esc(meta.commit.slice(0, 12))}</a> on ${esc(meta.branch)}</dd><dt>ran on</dt><dd>${esc(meta.backend)}${meta.build ? ` (build ${esc(meta.build)})` : ""}</dd><dt>finished</dt><dd>${esc(meta.finished)} after ${fmt(total)}</dd></dl>
<h2>Steps</h2>
<table><tr><th>step</th><th>result</th><th class="r">time</th><th></th></tr>${steps.map((s) => `<tr><td>${esc(s.name)}</td><td class="${s.result}">${s.result === "ok" ? "passed" : s.result === "fail" ? "failed" : "skipped"}</td><td class="r">${s.result === "skip" ? "" : fmt(s.seconds)}</td><td>${logLink(s)}</td></tr>`).join("")}</table>
${suites.length ? `<h2>Suites</h2>
<table><tr><th>suite</th><th>runtime</th><th>result</th><th>last line</th></tr>${suites.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.step === "suites" ? "Workers (dev)" : s.step === "suites-bun" ? "Bun" : esc(s.step)}</td><td class="${s.result === "PASS" ? "ok" : "fail"}">${s.result}</td><td>${esc(s.detail)}</td></tr>`).join("")}</table>` : ""}
${shots.length ? `<h2>Screenshots</h2>
<div class="shots">${shots.map((f) => `<figure><a href="logs/${esc(f)}"><img src="logs/${esc(f)}" alt="${esc(f)}" loading="lazy"></a><figcaption>${esc(f)}</figcaption></figure>`).join("")}</div>` : ""}
<h2>Files</h2>
<p><a href="status.json">status.json</a> · <a href="badge.svg">badge.svg</a> · <a href="logs/">logs/</a></p>`;
  writeFileSync(resolve(out, "index.html"), page(body, ok ? "ok" : "fail", `${meta.title}: ${ok ? "passing" : "failing"}`));
  console.log(`status page: ${out} (${ok ? "passing" : "failing"}, ${steps.length} steps, ${suites.length} suites, ${shots.length} screenshots)`);
}
function placeholder() {
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "status.json"), JSON.stringify({ ...meta, ok: null, steps: [], suites: [] }, null, 2) + "\n");
  writeFileSync(resolve(out, "badge.svg"), badge(kind === "release" ? "release" : "ci", "no build yet", "#8a8f88"));
  writeFileSync(resolve(out, "index.html"), page(`<h1>${esc(meta.title)} <span class="state none">no build yet</span></h1><p>Workers Builds replaces this page with the results of the first build.</p>`, "none", meta.title));
  console.log(`placeholder page: ${out}`);
}
if (cmd === "render") render(); else if (cmd === "placeholder") placeholder(); else { console.error("usage: bun scripts/ci-status.ts render|placeholder [--kind ci|release] [--out dir]"); process.exit(2); }
