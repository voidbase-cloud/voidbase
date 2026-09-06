// Which steps and suites a CI run needs (docs/ci.md, "Incremental runs"). Every step and suite lists the areas of the
// repository it depends on; an area's hash comes from the git blob ids of its files (plus a marker for uncommitted
// changes), and a step or suite runs only when the combined hash of its inputs differs from what the last green run
// recorded. That record is the deployed status page of master (CI_STATUS_URL, the status.json of the CI Worker) or,
// on a dev machine, ci/public/status.json from the previous run. CI_PLAN=full runs everything.
//   bun scripts/ci-plan.ts [--previous <file or url>] [--full]     writes .void/ci-plan.json and .void/ci-plan.txt
//   bun scripts/ci-plan.ts explain                                 the areas, their hashes and every key's inputs
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// the suites scripts/ci-suites.sh knows, by kind
export const CONFORMANCE = ["auth-flows", "backups", "batch", "cascade", "filter-corpus", "filters-extra", "hardening", "logs-crons", "manage-rule", "oauth2", "otp-mfa", "protected-files", "providers", "rules", "s3", "security", "settings", "sql", "thumbs", "views", "compare", "records", "realtime", "collections"];
export const BROWSER = ["panel-smoke", "panel-collections", "panel-records", "panel-admin", "panel-login"];
export const isBrowserKey = (key: string) => key.startsWith("suite:") && BROWSER.includes(key.slice(6));

// areas: named sets of repository paths (files or directories) whose content is hashed together
export const AREAS: Record<string, string[]> = {
  deps: ["package.json", "bun.lock"],
  harness: ["scripts/ci.sh", "scripts/ci-lib.sh", "scripts/ci-plan.ts", "scripts/ci-status.ts", "scripts/ci-oracles.sh"],
  "harness-suites": ["scripts/ci-suites.sh", "scripts/dev.sh", "scripts/seed-reference.sh", "scripts/seed-app-user.sh", "scripts/starter.sh", "scripts/sync-panel.ts", "scripts/sync-app.ts"],
  "harness-browser": ["scripts/ci-browser.sh"],
  config: ["vite.config.ts", "void.json", "hooks-plugin.ts", "env.ts", "wrangler.jsonc", "tsconfig.json", "tsconfig.node.json", "tsconfig.scripts.json", "types"],
  server: ["src/server", "src/platform", "routes", "db", "crons", "queues"],
  node: ["src/node", "bin", "scripts/build-exe.ts"],
  cloud: ["src/cloud"],
  mocks: ["test/smtp-sink.ts", "test/mock-oidc.ts", "test/s3-mock.ts", "test/cf-mock.ts"],
  fixtures: ["test/fixtures"],
  "unit-tests": ["test/unit"],
};
const testArea = (file: string) => { const name = `test:${file.replace(/^test\//, "").replace(/\.ts$/, "")}`; AREAS[name] = [file]; return name; };

// keys: the steps and suites that can be skipped, each with the areas it depends on. step:install, step:commitlint,
// step:oracles and step:plan always run; step:browser, step:boot, step:reference, step:suites and step:suites-bun
// follow from what is selected.
export const KEYS: Record<string, { inputs: string[] }> = {};
const base = ["deps", "harness", "config", "server"];
KEYS["step:typecheck"] = { inputs: ["deps", "config", "server", "node", "cloud"] };
KEYS["step:unit"] = { inputs: ["deps", "server", "node", "unit-tests"] };
KEYS["step:deploy-cf"] = { inputs: [...base, "harness-suites", "node", "cloud", "mocks", testArea("test/deploy-cf.ts")] };
KEYS["step:fresh-db"] = { inputs: [...base, "fixtures", testArea("test/fresh-db.ts")] };
KEYS["step:mail-http"] = { inputs: [...base, testArea("test/mail-http.ts")] };
KEYS["step:exe-smoke"] = { inputs: [...base, "node", testArea("test/exe-smoke.ts")] };
KEYS["step:starter"] = { inputs: [...base, "harness-suites", "harness-browser", testArea("test/starter-smoke.ts")] };
for (const s of CONFORMANCE) { const a = testArea(`test/conformance/${s}.ts`); KEYS[`suite:${s}`] = { inputs: [...base, "harness-suites", "mocks", a] }; KEYS[`bun:${s}`] = { inputs: [...base, "harness-suites", "mocks", "node", a] }; }
{ const a = testArea("test/sdk-suite.ts"); KEYS["suite:sdk-suite"] = { inputs: [...base, "harness-suites", "mocks", a] }; KEYS["bun:sdk-suite"] = { inputs: [...base, "harness-suites", "mocks", "node", a] }; }
KEYS["suite:cloud-rest"] = { inputs: ["deps", "harness", "harness-suites", "cloud", "node", "mocks", testArea("test/cloud-rest.ts")] };  // no server, so no Bun pass
for (const p of BROWSER) KEYS[`suite:${p}`] = { inputs: [...base, "harness-suites", "harness-browser", "mocks", testArea(`test/${p}.ts`)] };

export interface Decision { run: boolean; reason: string }
export type Decisions = Record<string, Decision>;
/** what runs, given the current combined hashes per key and the verified hashes of the last green run (null: none) */
export function decide(hashes: Record<string, string>, previous: Record<string, string> | null, opts: { full?: boolean; browser?: boolean } = {}): Decisions {
  const d: Decisions = {};
  for (const key of Object.keys(KEYS)) {
    if (opts.browser === false && (isBrowserKey(key) || key === "step:starter")) d[key] = { run: false, reason: "CI_BROWSER=0" };
    else if (opts.full) d[key] = { run: true, reason: "full run" };
    else if (!previous) d[key] = { run: true, reason: "no previous record" };
    else if (previous[key] !== hashes[key]) d[key] = { run: true, reason: previous[key] ? "inputs changed" : "never verified" };
    else d[key] = { run: false, reason: "inputs unchanged" };
  }
  const any = (prefix: string, filter: (k: string) => boolean = () => true) => Object.keys(d).some((k) => k.startsWith(prefix) && filter(k) && d[k]!.run);
  const suites = any("suite:"), bun = any("bun:"), browser = any("suite:", isBrowserKey) || d["step:starter"]!.run;
  const boot = any("suite:", (k) => k !== "suite:cloud-rest") || d["step:starter"]!.run;
  const reference = any("suite:", (k) => k !== "suite:cloud-rest") || bun || d["step:deploy-cf"]!.run;
  d["step:suites"] = { run: suites, reason: suites ? "suites selected" : "no suite selected" };
  d["step:suites-bun"] = { run: bun, reason: bun ? "suites selected" : "no suite selected" };
  d["step:browser"] = { run: browser, reason: browser ? "a browser suite runs" : "no browser suite runs" };
  d["step:boot"] = { run: boot, reason: boot ? "a suite needs the dev server" : "nothing needs the dev server" };
  d["step:reference"] = { run: reference, reason: reference ? "a suite needs the reference and the mocks" : "nothing needs the reference" };
  return d;
}
export const selected = (d: Decisions, prefix: string) => Object.keys(d).filter((k) => k.startsWith(prefix) && d[k]!.run).map((k) => k.slice(prefix.length));

const git = (a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: ROOT, stdout: "pipe", stderr: "ignore" }); return r.exitCode === 0 ? r.stdout.toString() : ""; };
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** the hash of an area: the index entries of its files; uncommitted changes never match a record */
export function areaHash(paths: string[]): string {
  const entries = git(["ls-files", "-s", "--", ...paths]).split("\n").filter(Boolean).sort().join("\n");
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--", ...paths]).trim();
  return short(dirty ? `${entries}\ndirty:${Date.now()}:${dirty}` : entries);
}
export const keyHash = (areas: Record<string, string>, inputs: string[]) => short(inputs.map((a) => `${a}=${areas[a] ?? "?"}`).join(";"));

async function previousRecord(source: string | undefined): Promise<{ source: string; commit: string; verified: Record<string, string> } | null> {
  if (!source) return null;
  try {
    let text: string;
    if (/^https?:\/\//.test(source)) { const res = await fetch(source, { signal: AbortSignal.timeout(15000) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); text = await res.text(); }
    else { if (!existsSync(source)) return null; text = readFileSync(source, "utf8"); }
    const j = JSON.parse(text) as { commit?: string; verified?: Record<string, string> };
    if (!j.verified || typeof j.verified !== "object") { console.log(`plan: ${source} has no verified hashes`); return null; }
    return { source, commit: j.commit ?? "", verified: j.verified };
  } catch (e) { console.log(`plan: previous record unavailable (${source}: ${e instanceof Error ? e.message : e})`); return null; }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const areas: Record<string, string> = {}; for (const [name, paths] of Object.entries(AREAS)) areas[name] = areaHash(paths);
  const hashes: Record<string, string> = {}; for (const [key, def] of Object.entries(KEYS)) hashes[key] = keyHash(areas, def.inputs);
  if (args[0] === "explain") {
    for (const [name, h] of Object.entries(areas)) console.log(`${h}  ${name}: ${AREAS[name]!.join(" ")}`);
    for (const [key, def] of Object.entries(KEYS)) console.log(`${hashes[key]}  ${key} <- ${def.inputs.join(" ")}`);
    process.exit(0);
  }
  const full = args.includes("--full") || process.env.CI_PLAN === "full" || process.env.CI_PLAN === "off";
  const source = opt("previous") ?? process.env.CI_STATUS_URL ?? (existsSync(resolve(ROOT, "ci/public/status.json")) ? resolve(ROOT, "ci/public/status.json") : undefined);
  const previous = full ? null : await previousRecord(source);
  const decisions = decide(hashes, previous?.verified ?? null, { full, browser: process.env.CI_BROWSER !== "0" });
  const commit = git(["rev-parse", "HEAD"]).trim();
  const out = resolve(ROOT, opt("out") ?? ".void"); mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "ci-plan.json"), JSON.stringify({ commit, full, previous: previous ? { source: previous.source, commit: previous.commit } : null, previousVerified: previous?.verified ?? {}, areas, hashes, decisions }, null, 2) + "\n");
  const lines = Object.entries(decisions).map(([k, v]) => `${k} ${v.run ? "run" : "skip"} ${v.reason}`);
  lines.push(`suites ${selected(decisions, "suite:").join(" ")}`, `bun ${selected(decisions, "bun:").join(" ")}`);
  writeFileSync(resolve(out, "ci-plan.txt"), lines.join("\n") + "\n");
  const keys = Object.keys(KEYS), ran = keys.filter((k) => decisions[k]!.run);
  const why = full ? "full run requested" : previous ? `against ${previous.source}${previous.commit ? ` (${previous.commit.slice(0, 10)})` : ""}` : "no previous record, everything runs";
  console.log(`plan: ${ran.length} of ${keys.length} checks run, ${keys.length - ran.length} skipped; ${why}`);
  console.log(`  steps: ${["typecheck", "unit", "browser", "boot", "reference", "suites", "suites-bun", "deploy-cf", "fresh-db", "mail-http", "exe-smoke", "starter"].map((s) => `${s}${decisions[`step:${s}`]!.run ? "" : "(skip)"}`).join(" ")}`);
  console.log(`  suites: ${selected(decisions, "suite:").join(" ") || "none"}`);
  console.log(`  bun: ${selected(decisions, "bun:").join(" ") || "none"}`);
}
