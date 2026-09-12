// Which steps and suites a CI run needs (docs/ci.md, "Incremental runs" and "Hot mode").
//
// Inputs are tracked at file level: every check has a set of files (the import closure of its test entry point, plus
// the runtime it exercises: the Workers server, the Bun runtime or the CLI, resolved through the same import graph),
// hashed from git blob ids, and it runs only when that hash differs from what the last green run recorded in the
// status page's status.json (`verified`; CI_STATUS_URL, or ci/public/status.json on a dev machine).
//
// Hot mode (CI_HOT=1 or --hot) keeps a run within a time budget (CI_HOT_BUDGET seconds, default 60): typecheck and
// unit always, then the checks named by the commits (`Tests:` trailer, changed test files), then the suites of the
// commits' Conventional Commit scopes, then the cheapest of the rest, using the durations the last run recorded;
// the Bun pass, the browser suites and the starter wait for a normal run. Deferred checks are never marked verified,
// so the first run without hot mode does them. `Tests: all` in a commit forces a full run; CI_PLAN=full too.
//   bun scripts/ci-plan.ts [--previous <file or url>] [--full] [--hot] [--budget 60]   writes .void/ci-plan.{json,txt}
//   bun scripts/ci-plan.ts explain                       the checks, their file counts and hashes
//   bun scripts/ci-plan.ts affected <file...>            the checks that depend on the given files
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// Every path below is repository-relative, the way `git ls-files` and `git diff --name-only` print them. The
// application and its suites live in the published package; only the CI and release tooling is at the root.
const PKG = "packages/voidbase";
const p = (f: string) => `${PKG}/${f}`;
/**
 * The extracted plugin packages: `packages/plugin-<name>`, read off the tracked tree rather than listed, so the next
 * extraction adds a directory and nothing here. Each is a whole small package -- source, manifest, tsconfig -- and
 * every file of one is an input to the typecheck, which runs each package's own tsc through the same glob
 * (`scripts/ci.sh`). Their *runtime* reach is deliberately not listed: the core imports a plugin package by name and
 * `Tree.resolveSpec` follows that import, so every check whose closure reaches the loading module has the plugin's
 * files in its set already.
 */
const pluginPackages = (t: Tree): string[] =>
  [...new Set(t.under("packages").flatMap((f) => { const m = /^(packages\/plugin-[^/]+)\/package\.json$/.exec(f); return m ? [m[1]!] : []; }))].sort();
export const CONFORMANCE = ["auth-flows", "backups", "batch", "cascade", "filter-corpus", "filters-extra", "hardening", "logs-crons", "manage-rule", "oauth2", "otp-mfa", "protected-files", "providers", "rules", "s3", "security", "settings", "sql", "thumbs", "views", "compare", "records", "realtime", "collections"];
export const BROWSER = ["panel-smoke", "panel-collections", "panel-records", "panel-admin", "panel-login"];
export const isBrowserKey = (key: string) => key.startsWith("suite:") && BROWSER.includes(key.slice(6));

// ---- what each check is: its kind, how hot mode treats it, the test file that names it, a default duration
export type HotClass = "mandatory" | "candidate" | "deferred";
export interface KeyMeta { kind: "step" | "suite" | "bun"; hot: HotClass; test?: string; seconds: number }
export const KEY_META: Record<string, KeyMeta> = {
  "step:typecheck": { kind: "step", hot: "mandatory", seconds: 15 },
  "step:unit": { kind: "step", hot: "mandatory", seconds: 1 },
  "step:deploy-cf": { kind: "step", hot: "candidate", test: p("test/deploy-cf.ts"), seconds: 8 },
  "step:fresh-db": { kind: "step", hot: "candidate", test: p("test/fresh-db.ts"), seconds: 13 },
  // deferred in hot mode for now: the step has never passed on Cloudflare (the production preview answers 500 there
  // while it passes locally), so it waits for a normal run and its own fix rather than failing every hot build
  "step:mail-http": { kind: "step", hot: "deferred", test: p("test/mail-http.ts"), seconds: 13 },
  "step:exe-smoke": { kind: "step", hot: "candidate", test: p("test/exe-smoke.ts"), seconds: 11 },
  "step:local": { kind: "step", hot: "candidate", test: p("test/local.ts"), seconds: 12 },
  "step:starter": { kind: "step", hot: "deferred", test: p("test/starter-smoke.ts"), seconds: 28 },
  "step:adapter": { kind: "step", hot: "candidate", test: p("test/adapter.ts"), seconds: 20 },
};
const SUITE_SECONDS: Record<string, number> = { "auth-flows": 11, backups: 3, batch: 1, cascade: 3, "filter-corpus": 26, "filters-extra": 1, hardening: 57, "logs-crons": 7, "manage-rule": 1, oauth2: 2, "otp-mfa": 20, "protected-files": 1, providers: 1, rules: 3, s3: 5, security: 5, settings: 1, sql: 1, thumbs: 4, views: 1, compare: 1, records: 6, realtime: 1, collections: 2, "sdk-suite": 26, "cloud-rest": 1 };
for (const s of CONFORMANCE) { KEY_META[`suite:${s}`] = { kind: "suite", hot: "candidate", test: p(`test/conformance/${s}.ts`), seconds: SUITE_SECONDS[s] ?? 5 }; KEY_META[`bun:${s}`] = { kind: "bun", hot: "deferred", test: p(`test/conformance/${s}.ts`), seconds: SUITE_SECONDS[s] ?? 5 }; }
KEY_META["suite:sdk-suite"] = { kind: "suite", hot: "candidate", test: p("test/sdk-suite.ts"), seconds: 26 };
KEY_META["bun:sdk-suite"] = { kind: "bun", hot: "deferred", test: p("test/sdk-suite.ts"), seconds: 26 };
KEY_META["suite:cloud-rest"] = { kind: "suite", hot: "candidate", test: p("test/cloud-rest.ts"), seconds: 1 };
for (const b of BROWSER) KEY_META[`suite:${b}`] = { kind: "suite", hot: "deferred", test: p(`test/${b}.ts`), seconds: 20 };
export const KEYS = Object.keys(KEY_META);

// the suites a Conventional Commit scope points at (commitlint.config.js lists the scopes)
export const SCOPE_KEYS: Record<string, string[]> = {
  records: ["suite:records", "suite:batch", "suite:cascade", "suite:filters-extra", "suite:rules", "suite:manage-rule", "suite:filter-corpus"],
  collections: ["suite:collections", "suite:views", "suite:rules"],
  auth: ["suite:auth-flows", "suite:otp-mfa", "suite:security", "suite:providers"],
  oauth2: ["suite:oauth2", "suite:providers"],
  realtime: ["suite:realtime"], hub: ["suite:realtime"],
  jobs: ["suite:auth-flows", "step:mail-http"], mail: ["suite:auth-flows", "step:mail-http"],
  files: ["suite:s3", "suite:thumbs", "suite:protected-files"],
  hooks: ["step:fresh-db"], plugin: ["step:fresh-db"], migrations: ["step:fresh-db", "suite:collections"],
  settings: ["suite:settings"], logs: ["suite:logs-crons"], crons: ["suite:logs-crons"], backups: ["suite:backups"],
  hardening: ["suite:hardening", "suite:security"], deploy: ["step:deploy-cf"], cloud: ["suite:cloud-rest"], bundle: ["suite:cloud-rest"],
  cli: ["step:exe-smoke", "step:local"], adapter: ["step:adapter"], serve: ["bun:records", "bun:collections", "bun:auth-flows"], panel: ["suite:panel-smoke"], starter: ["step:starter"],
};

// ---- the decision: what runs, given current hashes and the last green run's verified hashes
export interface Decision { run: boolean; reason: string }
export type Decisions = Record<string, Decision>;
export interface CommitSignals { scopes: string[]; tests: string[]; full: boolean; changed: string[]; releasable: boolean; dryRun: boolean; releaseMerge: boolean }
export interface DecideOptions { full?: boolean; browser?: boolean; hot?: boolean; budget?: number; seconds?: Record<string, number>; signals?: CommitSignals }
const suiteName = (key: string) => key.replace(/^(suite|bun|step):/, "");
export function decide(hashes: Record<string, string>, previous: Record<string, string> | null, opts: DecideOptions = {}): Decisions {
  const d: Decisions = {};
  const full = opts.full || opts.signals?.full;
  for (const key of KEYS) {
    if (opts.browser === false && (isBrowserKey(key) || key === "step:starter")) d[key] = { run: false, reason: "CI_BROWSER=0" };
    else if (full) d[key] = { run: true, reason: opts.signals?.full ? "full run (Tests: all)" : "full run" };
    else if (!previous) d[key] = { run: true, reason: "no previous record" };
    else if (previous[key] !== hashes[key]) d[key] = { run: true, reason: previous[key] ? "inputs changed" : "never verified" };
    else d[key] = { run: false, reason: "inputs unchanged" };
  }
  if (opts.hot && !full) hot(d, opts);
  derive(d);
  return d;
}
/** hot mode: keep the selected checks within the budget, in the order the commits suggest */
function hot(d: Decisions, opts: DecideOptions) {
  const budget = opts.budget ?? 60, s = opts.signals, secs = (k: string) => opts.seconds?.[k] ?? KEY_META[k]!.seconds;
  const named = new Set((s?.tests ?? []).flatMap((t) => (t === "bun" ? KEYS.filter((k) => k.startsWith("bun:")) : t === "browser" ? KEYS.filter(isBrowserKey) : KEYS.filter((k) => suiteName(k) === t))));
  const scoped = new Set((s?.scopes ?? []).flatMap((sc) => SCOPE_KEYS[sc] ?? []));
  const changedTest = (k: string) => !!KEY_META[k]!.test && (s?.changed ?? []).includes(KEY_META[k]!.test!);
  // the minimal set the commits declare always runs: typecheck and unit, the checks named by a Tests: trailer, the
  // suites of the commits' scopes, and a suite whose own file changed; the budget then buys the cheapest of the rest
  const scopeOf = (k: string) => (s?.scopes ?? []).find((sc) => SCOPE_KEYS[sc]?.includes(k));
  let spent = 0;
  const forced = KEYS.filter((k) => d[k]!.run && (KEY_META[k]!.hot === "mandatory" || named.has(k) || changedTest(k) || scoped.has(k)));
  for (const k of forced) { spent += secs(k); d[k] = { run: true, reason: KEY_META[k]!.hot === "mandatory" ? "hot mode: always" : named.has(k) ? "hot mode: named by the commits" : changedTest(k) ? "hot mode: its test changed" : `hot mode: scope ${scopeOf(k)}` }; }
  const rest = KEYS.filter((k) => d[k]!.run && !forced.includes(k));
  for (const k of rest) if (KEY_META[k]!.hot === "deferred") d[k] = { run: false, reason: "deferred (hot mode)" };
  for (const k of rest.filter((x) => KEY_META[x]!.hot === "candidate").sort((a, b) => secs(a) - secs(b))) {
    if (spent + secs(k) <= budget) { spent += secs(k); d[k] = { run: true, reason: "hot mode: within the budget" }; }
    else d[k] = { run: false, reason: `deferred (hot mode, budget ${budget}s)` };
  }
}
/** the infrastructure steps follow from what is selected */
function derive(d: Decisions) {
  const any = (prefix: string, filter: (k: string) => boolean = () => true) => Object.keys(d).some((k) => k.startsWith(prefix) && filter(k) && d[k]!.run);
  const suites = any("suite:"), bun = any("bun:"), browser = any("suite:", isBrowserKey) || d["step:starter"]!.run;
  // fresh-db seeds its isolated D1 from the dev server's file (test/fresh-db.ts), so it needs the boot too
  const boot = any("suite:", (k) => k !== "suite:cloud-rest") || d["step:starter"]!.run || d["step:fresh-db"]!.run;
  const reference = any("suite:", (k) => k !== "suite:cloud-rest") || bun || d["step:deploy-cf"]!.run;
  d["step:suites"] = { run: suites, reason: suites ? "suites selected" : "no suite selected" };
  d["step:suites-bun"] = { run: bun, reason: bun ? "suites selected" : "no suite selected" };
  d["step:browser"] = { run: browser, reason: browser ? "a browser suite runs" : "no browser suite runs" };
  d["step:boot"] = { run: boot, reason: boot ? (d["step:fresh-db"]!.run && !any("suite:", (k) => k !== "suite:cloud-rest") && !d["step:starter"]!.run ? "fresh-db needs the dev server's D1 file" : "a suite needs the dev server") : "nothing needs the dev server" };
  d["step:reference"] = { run: reference, reason: reference ? "a suite needs the reference and the mocks" : "nothing needs the reference" };
  const oracles = d["step:typecheck"]!.run || boot || bun || d["step:exe-smoke"]!.run || d["step:deploy-cf"]!.run || d["step:starter"]!.run;
  d["step:oracles"] = { run: oracles, reason: oracles ? "a selected step needs the starter, the panel or the generated types" : "nothing needs the oracles" };
}
export const selected = (d: Decisions, prefix: string) => Object.keys(d).filter((k) => k.startsWith(prefix) && d[k]!.run).map((k) => k.slice(prefix.length));

// ---- files: the tracked tree, the import graph, the file set of every check
const git = (a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: ROOT, stdout: "pipe", stderr: "ignore" }); return r.exitCode === 0 ? r.stdout.toString() : ""; };
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
type ExportTarget = string | { workerd?: string; default?: string };
export class Tree {
  blobs = new Map<string, string>(); dirty = new Set<string>(); imports: Record<string, { workerd?: string; default?: string }> = {};
  /** the workspace packages by name, with the `exports` map each publishes: a bare import of one is a file in here */
  packages: Record<string, { dir: string; exports: Record<string, ExportTarget> }> = {};
  private parsed = new Map<string, string[]>();
  constructor() {
    for (const line of git(["ls-files", "-s"]).split("\n")) { const m = line.match(/^\d+ ([0-9a-f]{40}) \d\t(.+)$/); if (m) this.blobs.set(m[2]!, m[1]!); }
    for (const line of git(["status", "--porcelain", "--untracked-files=all"]).split("\n")) { const p = line.slice(3).trim(); if (p) this.dirty.add(p.includes(" -> ") ? p.split(" -> ")[1]! : p); }
    try { const pkg = JSON.parse(readFileSync(resolve(ROOT, `${PKG}/package.json`), "utf8")) as { imports?: Record<string, { workerd?: string; default?: string }> }; for (const [k, v] of Object.entries(pkg.imports ?? {})) this.imports[k] = { workerd: v.workerd && p(v.workerd.replace(/^\.\//, "")), default: v.default && p(v.default.replace(/^\.\//, "")) }; } catch { /* no aliases */ }
    // and the workspace's own packages, read from the root manifest's globs rather than named here, so that the
    // package 7.6 adds is followed without an edit
    const patterns = (() => { try { return (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { workspaces?: string[] }).workspaces ?? []; } catch { return []; } })();
    for (const dir of new Set([...this.blobs.keys()].flatMap((f) => { const m = /^(.+)\/package\.json$/.exec(f); return m && patterns.some((q) => q.replace(/\/\*$/, "") === posix.dirname(m[1]!)) ? [m[1]!] : []; }))) {
      try { const m = JSON.parse(readFileSync(resolve(ROOT, dir, "package.json"), "utf8")) as { name?: string; exports?: Record<string, ExportTarget> | string }; if (m.name && m.exports && typeof m.exports === "object") this.packages[m.name] = { dir, exports: m.exports }; } catch { /* not a package this reads */ }
    }
  }
  has(f: string) { return this.blobs.has(f); }
  under(...prefixes: string[]): string[] { return [...this.blobs.keys()].filter((f) => prefixes.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : p + "/"))); }
  /** the import specifiers of a file */
  specs(file: string): string[] {
    if (this.parsed.has(file)) return this.parsed.get(file)!;
    let text = ""; try { text = readFileSync(resolve(ROOT, file), "utf8"); } catch { /* deleted */ }
    const out: string[] = []; const re = /\b(?:import|export)\s*(?:[\w*\s{},$]*?\s*from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]!);
    this.parsed.set(file, out); return out;
  }
  /**
   * A bare import of a workspace package -- `@voidbase-cloud/plugin-realtime`, or this package's own name from
   * another package of the workspace -- is a file in this tree and not a dependency to stop at. Since 7.5 the core
   * imports an extracted plugin by name, so a closure that stopped here would put a check's own runtime outside its
   * file set: the plugin could change under it and the check would still count as verified. Resolved through the
   * package's published `exports`, taking the same condition the flavour would.
   */
  workspaceFile(spec: string, flavour: "workerd" | "bun"): string | null {
    const name = Object.keys(this.packages).find((n) => spec === n || spec.startsWith(`${n}/`));
    if (!name) return null;
    const pkg = this.packages[name]!;
    const target = pkg.exports[spec === name ? "." : `.${spec.slice(name.length)}`];
    const file = typeof target === "string" ? target : ((flavour === "workerd" ? target?.workerd : target?.default) ?? target?.default);
    if (!file) return null;
    const f = posix.join(pkg.dir, file.replace(/^\.\//, ""));
    return this.has(f) ? f : null;
  }
  resolveSpec(from: string, spec: string, flavour: "workerd" | "bun"): string | null {
    if (spec.startsWith("#")) { const t = this.imports[spec]; const f = (flavour === "workerd" ? t?.workerd : t?.default) ?? t?.default; return f && this.has(f) ? f : null; }
    if (!spec.startsWith(".")) return this.workspaceFile(spec, flavour);  // other packages, void/*, node:* resolve to nothing
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const c of [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), posix.join(base, "index.ts")]) if (this.has(c)) return c;
    return null;
  }
  /** every tracked file reachable from the entries through imports */
  closure(entries: string[], flavour: "workerd" | "bun"): Set<string> {
    const seen = new Set<string>(); const queue = entries.filter((e) => this.has(e));
    while (queue.length) { const f = queue.pop()!; if (seen.has(f)) continue; seen.add(f); if (!/\.(ts|tsx|js|mjs)$/.test(f)) continue; for (const spec of this.specs(f)) { const r = this.resolveSpec(f, spec, flavour); if (r && !seen.has(r)) queue.push(r); } }
    return seen;
  }
  hash(files: Iterable<string>): string {
    const lines = [...files].sort().map((f) => `${f}=${this.blobs.get(f) ?? "?"}${this.dirty.has(f) ? `*${Date.now()}` : ""}`);
    return short(lines.join("\n"));
  }
}
/** the file sets of every check */
export function keyFiles(t: Tree): Record<string, Set<string>> {
  const union = (...sets: Iterable<string>[]) => { const s = new Set<string>(); for (const x of sets) for (const f of x) s.add(f); return s; };
  const plugins = pluginPackages(t);
  const deps = ["package.json", "bun.lock", "bunfig.toml", p("package.json"), ...plugins.map((d) => `${d}/package.json`)];
  const harness = ["scripts/ci.sh", "scripts/ci-lib.sh", "scripts/ci-plan.ts", "scripts/ci-status.ts", "scripts/ci-oracles.sh"];
  const harnessSuites = ["scripts/ci-suites.sh", "scripts/dev.sh", "scripts/seed-reference.sh", "scripts/starter.sh", p("scripts/seed-app-user.sh"), p("scripts/sync-panel.ts"), p("scripts/sync-app.ts")];
  const harnessBrowser = ["scripts/ci-browser.sh"];
  const config = [p("vite.config.ts"), p("void.json"), p("hooks-plugin.ts"), p("env.ts"), p("wrangler.jsonc"), p("tsconfig.json"), p("tsconfig.node.json"), "tsconfig.scripts.json"];
  const mocks = t.closure([p("test/smtp-sink.ts"), p("test/mock-oidc.ts"), p("test/s3-mock.ts"), p("test/cf-mock.ts")], "bun");
  const SERVER = union(t.closure([...t.under(p("routes"), p("crons"), p("queues")), p("hooks-plugin.ts"), p("vite.config.ts")], "workerd"), t.under(p("db"), p("types")), config);
  const BUN = union(t.closure([p("src/node/serve.ts")], "bun"), [p("bin/voidbase.ts")], t.under(p("db"), p("types")));
  const CLI = t.closure([p("bin/voidbase.ts")], "bun");
  const common = union(deps, harness);
  const out: Record<string, Set<string>> = {};
  // `bun run check` runs each plugin package's own tsc as well as the core's two, so every file of one is an input
  // here -- its tsconfig included, which no closure reaches
  out["step:typecheck"] = union(t.under(p("src"), p("routes"), p("bin"), p("crons"), p("queues"), p("db"), p("types")).filter((f) => /\.tsx?$/.test(f)), t.under(...plugins), [p("env.ts"), p("hooks-plugin.ts"), p("vite.config.ts"), "scripts/cf-builds.ts", "scripts/gh-release.ts", "scripts/ci-status.ts", "scripts/ci-plan.ts", "scripts/pipeline.ts", "scripts/environment.ts", "scripts/publish.ts", "scripts/hot-release.ts"], config, deps);
  // the release fixture is a whole package the unit suite reads off disk (test/unit/publish.test.ts packs it and
  // asserts what keeps it off npm), so every file in it counts -- no import reaches it and the closure cannot see it
  out["step:unit"] = union(t.closure(t.under(p("test/unit")), "bun"), t.under("packages/release-fixture"), common);
  out["step:deploy-cf"] = union(t.closure([p("test/deploy-cf.ts")], "bun"), CLI, SERVER, mocks, common, harnessSuites);
  out["step:fresh-db"] = union(t.closure([p("test/fresh-db.ts")], "bun"), SERVER, t.under(p("test/fixtures")), common);
  out["step:mail-http"] = union(t.closure([p("test/mail-http.ts")], "bun"), SERVER, common);
  out["step:exe-smoke"] = union(t.closure([p("test/exe-smoke.ts")], "bun"), CLI, ["scripts/build-exe.ts"], common);
  out["step:local"] = union(t.closure([p("test/local.ts")], "bun"), CLI, common);
  out["step:starter"] = union(t.closure([p("test/starter-smoke.ts")], "bun"), SERVER, common, harnessSuites, harnessBrowser);
  // the fixture is a whole Void app the test converts, so every file under it counts, not just what a closure reaches
  out["step:adapter"] = union(t.closure([p("test/adapter.ts")], "bun"), SERVER, t.under(p("src/adapter")), t.under(p("test/fixtures/void-app")), [p("hooks-plugin.ts")], common);
  for (const s of CONFORMANCE) { const own = t.closure([p(`test/conformance/${s}.ts`)], "bun"); out[`suite:${s}`] = union(own, SERVER, mocks, common, harnessSuites); out[`bun:${s}`] = union(own, BUN, mocks, common, harnessSuites); }
  { const own = t.closure([p("test/sdk-suite.ts")], "bun"); out["suite:sdk-suite"] = union(own, SERVER, mocks, common, harnessSuites); out["bun:sdk-suite"] = union(own, BUN, mocks, common, harnessSuites); }
  out["suite:cloud-rest"] = union(t.closure([p("test/cloud-rest.ts")], "bun"), mocks, common, harnessSuites);
  for (const b of BROWSER) out[`suite:${b}`] = union(t.closure([p(`test/${b}.ts`)], "bun"), SERVER, mocks, common, harnessSuites, harnessBrowser);
  return out;
}

// ---- the previous record and the commits since it
interface Record_ { source: string; commit: string; verified: Record<string, string>; seconds: Record<string, number> }
async function previousRecord(source: string | undefined): Promise<Record_ | null> {
  if (!source) return null;
  try {
    let text: string;
    if (/^https?:\/\//.test(source)) { const res = await fetch(source, { signal: AbortSignal.timeout(15000) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); text = await res.text(); }
    else { if (!existsSync(source)) return null; text = readFileSync(source, "utf8"); }
    const j = JSON.parse(text) as { commit?: string; verified?: Record<string, string>; steps?: { name: string; seconds: number; result: string }[]; suites?: { step: string; name: string; seconds?: number }[] };
    if (!j.verified || typeof j.verified !== "object") { console.log(`plan: ${source} has no verified hashes`); return null; }
    const seconds: Record<string, number> = {};
    for (const s of j.steps ?? []) if (s.result === "ok" && s.seconds > 0) seconds[`step:${s.name}`] = s.seconds;
    for (const s of j.suites ?? []) if (s.seconds) seconds[`${s.step === "suites-bun" ? "bun" : "suite"}:${s.name}`] = s.seconds;
    return { source, commit: j.commit ?? "", verified: j.verified, seconds };
  } catch (e) { console.log(`plan: previous record unavailable (${source}: ${e instanceof Error ? e.message : e})`); return null; }
}
/** what the commits since the record say: scopes, `Tests:` trailers, whether a release can change (a feat, fix,
 * perf or revert commit, a breaking change), a `Release: dry-run` trailer, the merge of the release PR */
export function parseCommits(messages: string[]): Omit<CommitSignals, "changed"> {
  const scopes = new Set<string>(), tests = new Set<string>(); let full = false, releasable = false, dryRun = false, releaseMerge = false;
  for (const m of messages) {
    const head = m.split("\n")[0] ?? ""; const sc = head.match(/^\w+\(([^)]+)\)!?:/); if (sc) for (const s of sc[1]!.split(",")) scopes.add(s.trim());
    if (/^(feat|fix|perf|revert)(\(|!|:)|^[a-z]+(\([^)]*\))?!:/.test(head)) releasable = true;
    if (/^chore\(master\): release|^Merge pull request .*release-please/.test(head)) releaseMerge = true;
    for (const line of m.split("\n")) {
      const t = line.match(/^tests?:\s*(.+)$/i); if (t) for (const name of t[1]!.split(/[\s,]+/).filter(Boolean)) { if (name === "all" || name === "full") full = true; else tests.add(name); }
      if (/^release:\s*dry[- ]?run\s*$/i.test(line)) dryRun = true;
    }
  }
  return { scopes: [...scopes], tests: [...tests], full, releasable, dryRun, releaseMerge };
}
function commitSignals(prevCommit: string): CommitSignals {
  const isAncestor = () => !!prevCommit && Bun.spawnSync(["git", "merge-base", "--is-ancestor", prevCommit, "HEAD"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  let ancestor = isAncestor();
  // a Cloudflare build checks out the one commit it builds. The record's commit is further back, and a push can
  // carry several commits, so the history is deepened until it is reachable: reading the head commit alone would
  // miss the other commits' scopes, their Tests: trailers and whether anything releasable was pushed.
  if (prevCommit && !ancestor && git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    for (const depth of ["50", "500"]) {
      Bun.spawnSync(["git", "fetch", "--quiet", `--deepen=${depth}`, "origin"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
      if ((ancestor = isAncestor())) break;
    }
  }
  const range = ancestor ? `${prevCommit}..HEAD` : "-1";
  const messages = git(["log", "--format=%B%x00", range]).split("\0").map((m) => m.trim()).filter(Boolean);
  const changed = ancestor ? git(["diff", "--name-only", prevCommit, "HEAD"]).split("\n").filter(Boolean) : [];
  const parsed = parseCommits(messages);
  // the release merge is a property of the head commit alone, not of anything older in the range
  const head = git(["log", "-1", "--format=%s"]).trim();
  return { ...parsed, releaseMerge: /^chore\(master\): release|^Merge pull request .*release-please/.test(head), changed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const tree = new Tree(); const files = keyFiles(tree);
  const hashes: Record<string, string> = {}; for (const [key, set] of Object.entries(files)) hashes[key] = tree.hash(set);
  if (args[0] === "explain") { for (const key of KEYS) console.log(`${hashes[key]}  ${key}: ${files[key]!.size} files`); process.exit(0); }
  if (args[0] === "affected") { const wanted = args.slice(1); for (const key of KEYS) { const hit = wanted.filter((f) => files[key]!.has(f)); if (hit.length) console.log(`${key} <- ${hit.join(" ")}`); } process.exit(0); }
  const full = args.includes("--full") || process.env.CI_PLAN === "full" || process.env.CI_PLAN === "off";
  const hotMode = args.includes("--hot") || process.env.CI_HOT === "1";
  const budget = Number(opt("budget") ?? process.env.CI_HOT_BUDGET ?? 60);
  const source = opt("previous") ?? process.env.CI_STATUS_URL ?? (existsSync(resolve(ROOT, "ci/public/status.json")) ? resolve(ROOT, "ci/public/status.json") : undefined);
  const previous = full ? null : await previousRecord(source);
  const signals = commitSignals(previous?.commit ?? "");
  const decisions = decide(hashes, previous?.verified ?? null, { full, browser: process.env.CI_BROWSER !== "0", hot: hotMode, budget, seconds: previous?.seconds, signals });
  const commit = git(["rev-parse", "HEAD"]).trim();
  const out = resolve(ROOT, opt("out") ?? ".void"); mkdirSync(out, { recursive: true });
  const changedIn = (key: string) => signals.changed.filter((f) => files[key]!.has(f));
  for (const key of KEYS) { const c = changedIn(key); if (decisions[key]!.run && decisions[key]!.reason === "inputs changed" && c.length) decisions[key]!.reason = `inputs changed (${c.slice(0, 3).join(", ")}${c.length > 3 ? ", ..." : ""})`; }
  const deferred = KEYS.filter((k) => decisions[k]!.reason.startsWith("deferred"));
  writeFileSync(resolve(out, "ci-plan.json"), JSON.stringify({ commit, full, hot: hotMode ? { budget, deferred } : null, signals, previous: previous ? { source: previous.source, commit: previous.commit } : null, previousVerified: previous?.verified ?? {}, hashes, decisions }, null, 2) + "\n");
  const lines = Object.entries(decisions).map(([k, v]) => `${k} ${v.run ? "run" : "skip"} ${v.reason}`);
  lines.push(`suites ${selected(decisions, "suite:").join(" ")}`, `bun ${selected(decisions, "bun:").join(" ")}`);
  lines.push(`release-pr ${signals.releasable ? "yes" : "no"}`, `release-merge ${signals.releaseMerge ? "yes" : "no"}`, `release-dry-run ${signals.dryRun ? "yes" : "no"}`);
  writeFileSync(resolve(out, "ci-plan.txt"), lines.join("\n") + "\n");
  const ran = KEYS.filter((k) => decisions[k]!.run);
  const why = full ? "full run requested" : previous ? `against ${previous.source}${previous.commit ? ` (${previous.commit.slice(0, 10)})` : ""}` : "no previous record, everything runs";
  console.log(`plan: ${ran.length} of ${KEYS.length} checks run, ${KEYS.length - ran.length} skipped${hotMode ? `, hot mode (budget ${budget}s, ${deferred.length} deferred)` : ""}; ${why}`);
  if (signals.changed.length) console.log(`  changed: ${signals.changed.length} files (${signals.changed.slice(0, 6).join(", ")}${signals.changed.length > 6 ? ", ..." : ""})`);
  if (signals.scopes.length || signals.tests.length) console.log(`  commits: scopes ${signals.scopes.join(", ") || "none"}; Tests: ${signals.tests.join(", ") || "none"}`);
  console.log(`  release: ${signals.releaseMerge ? "release merge" : signals.releasable ? "releasable commits, the release PR is refreshed" : "nothing releasable"}${signals.dryRun ? "; dry run requested" : ""}`);
  console.log(`  steps: ${["oracles", "typecheck", "unit", "browser", "boot", "reference", "suites", "suites-bun", "deploy-cf", "adapter", "fresh-db", "mail-http", "exe-smoke", "local", "starter"].map((s) => `${s}${decisions[`step:${s}`]!.run ? "" : "(skip)"}`).join(" ")}`);
  console.log(`  suites: ${selected(decisions, "suite:").join(" ") || "none"}`);
  console.log(`  bun: ${selected(decisions, "bun:").join(" ") || "none"}`);
}
