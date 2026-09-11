// `voidbase cloud <verb>`: everything the voidbase.cloud dashboard does, from a terminal, so nothing is
// dashboard-only. The site keeps the sign-in and the sealed Cloudflare and GitHub tokens; this signs in with the
// CLI token the cloud page shows and does the work through the same client the page holds (src/cloud/client.ts):
// instances are provisioned, upgraded and deleted in the user's own Cloudflare account through the site's
// pass-through, repositories are created and linked on GitHub the same way, and an instance's plugins are changed
// by the instance's own installer with a session minted on it. Plain HTTP, no toolchain: it works from the
// prebuilt executable. The session lives in ~/.config/voidbase/cloud.json (XDG_CONFIG_HOME respected), mode 600.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CloudClient, CloudError, type Instance, type Repo, type Template } from "../cloud/client";

export const DEFAULT_URL = "https://voidbase.cloud";
export interface CloudConfig { url: string; token: string }
export const configPath = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "voidbase", "cloud.json");
export function readConfig(): CloudConfig | null {
  const p = configPath(); if (!existsSync(p)) return null;
  try { const c = JSON.parse(readFileSync(p, "utf8")) as Partial<CloudConfig>; return c.token ? { url: (c.url || DEFAULT_URL).replace(/\/$/, ""), token: c.token } : null; } catch { return null; }
}
export function writeConfig(c: CloudConfig): string {
  const p = configPath(); mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ url: c.url, token: c.token }, null, 2) + "\n", { mode: 0o600 }); chmodSync(p, 0o600);
  return p;
}
export function removeConfig(): boolean { const p = configPath(); if (!existsSync(p)) return false; rmSync(p); return true; }

export const TOKEN_HELP = `A token comes from the cloud page: sign in at ${DEFAULT_URL}/cloud, and the page shows a "CLI token" for the signed-in user.
Then:  voidbase cloud login --token <token>   (--url for a site other than ${DEFAULT_URL})`;
export const USAGE = `usage: voidbase cloud <verb>
  login --token <token> [--url ${DEFAULT_URL}]     logout     whoami
  instances [ls] | create <name> [--account id] [--email superuser@] | upgrade <name> | delete <name> [--yes]
  repos [ls] | create <instance> --template <name> --name <repo> [--private] [--inputs k=v,k=v] | link <instance> <owner/name> [--template name] | unlink <owner/name>
  plugins <instance> [ls | install <name>[@version] [--marketplace url] | remove <name> [--yes] | update [name]] --email .. --password ..
  every verb takes --json (the raw result); an instance is named by its name or its id`;

/** what a verb refuses with: the message is printed, the code is the exit code (2: usage or not signed in) */
export class CliError extends Error { constructor(message: string, public code = 1) { super(message); } }
export interface Io { out(line: string): void; err(line: string): void; isTTY?: boolean; confirm?(prompt: string): Promise<string> }

// ---- the site, with the session -------------------------------------------------------------------------------
interface Me { user: { id: string; email: string; name?: string; superuser?: boolean }; admin?: boolean; connected: boolean; connection: { email?: string; name?: string; cfUserId?: string; scopes?: string; expiry?: string; accounts?: { id: string; name?: string }[] } | null; prefix?: string; maxInstances?: number; providerConfigured?: boolean }
interface Github { configured: boolean; connected: boolean; connection: { login?: string; name?: string } | null }
interface Session { url: string; token: string; client: CloudClient }
async function siteGet<T>(s: Session, path: string): Promise<T> {
  const r = await fetch(`${s.url}${path}`, { headers: { authorization: s.token } });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401 || r.status === 403) throw new CliError(`${s.url} refused the token (${r.status}): sign in again with voidbase cloud login --token <token>`, 2);
  if (!r.ok) throw new CliError(String(json.message ?? `${path}: ${r.status}`));
  return json as T;
}
const me = (s: Session) => siteGet<Me>(s, "/api/vbcloud/me");
const instances = async (s: Session) => (await siteGet<{ instances: Instance[] }>(s, "/api/vbcloud/instances")).instances ?? [];
const repos = async (s: Session) => (await siteGet<{ repos: Repo[] }>(s, "/api/vbcloud/repos")).repos ?? [];
const templates = async (s: Session) => (await siteGet<{ templates: Template[] }>(s, "/api/vbcloud/templates")).templates ?? [];
const github = (s: Session) => siteGet<Github>(s, "/api/vbcloud/github").catch(() => null);

function session(flags: Record<string, string>): Session {
  const cfg = readConfig();
  const url = (flags.url ?? cfg?.url ?? DEFAULT_URL).replace(/\/$/, "");
  const token = flags.token ?? process.env.VOIDBASE_CLOUD_TOKEN ?? cfg?.token;
  if (!token) throw new CliError(`not signed in.\n${TOKEN_HELP}`, 2);
  return { url, token, client: new CloudClient(url, () => token) };
}

/** by name, by id, or by the name without the site's prefix when that is unambiguous (my-shop finds vb-my-shop) */
export function pickInstance(list: Instance[], ref: string): Instance {
  const exact = list.find((i) => i.name === ref || i.id === ref); if (exact) return exact;
  const suffix = list.filter((i) => i.name.endsWith(`-${ref}`));
  if (suffix.length === 1) return suffix[0]!;
  if (suffix.length > 1) throw new CliError(`"${ref}" could be ${suffix.map((i) => i.name).join(" or ")}: say which`);
  throw new CliError(list.length ? `no instance called "${ref}" (you have: ${list.map((i) => i.name).join(", ")})` : `no instance called "${ref}": there are none yet (voidbase cloud instances create <name>)`);
}
export function pickTemplate(list: Template[], ref: string): Template {
  const t = list.find((x) => x.name === ref || x.id === ref || x.repo === ref);
  if (!t) throw new CliError(list.length ? `no template called "${ref}" (the site offers: ${list.map((x) => x.name).join(", ")})` : `no template called "${ref}": the site offers none`);
  return t;
}
/** owner/name, or a GitHub URL, the way the client normalises it */
export const repoName = (ref: string) => ref.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
export function pickRepo(list: Repo[], ref: string): Repo {
  const want = repoName(ref);
  const r = list.find((x) => x.fullName.toLowerCase() === want || x.id === ref);
  if (!r) throw new CliError(list.length ? `no linked repository called "${want}" (linked: ${list.map((x) => x.fullName).join(", ")})` : `no linked repository called "${want}": none are linked`);
  return r;
}
/** k=v,k=v into the inputs a template's input: variables read */
export const parseInputs = (s?: string): Record<string, string> => Object.fromEntries((s ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf("="); return i < 0 ? [p, ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
/** name@version: the last @ splits, so a scoped-looking name keeps its first character */
export const parseSpec = (spec: string): { name: string; version?: string } => { const i = spec.lastIndexOf("@"); return i > 0 ? { name: spec.slice(0, i), version: spec.slice(i + 1) } : { name: spec }; };

async function pickAccount(s: Session, wanted?: string): Promise<{ id: string; name?: string; me: Me }> {
  const m = await me(s); const accounts = m.connection?.accounts ?? [];
  if (!m.connected || !accounts.length) throw new CliError(`your Cloudflare connection on ${s.url} reaches no account: connect Cloudflare on the cloud page first`);
  if (wanted) { const a = accounts.find((x) => x.id === wanted || x.name === wanted); if (!a) throw new CliError(`account "${wanted}" is not one the connection reaches (${accounts.map((x) => `${x.name ?? ""} ${x.id}`.trim()).join(", ")})`); return { ...a, me: m }; }
  if (accounts.length > 1) throw new CliError(`the connection reaches ${accounts.length} accounts, pick one with --account: ${accounts.map((x) => `${x.name ?? ""} (${x.id})`.trim()).join(", ")}`);
  return { ...accounts[0]!, me: m };
}
const instanceLine = (i: Instance) => `  ${i.name.padEnd(28)} ${i.status.padEnd(10)} ${(i.release ? `release ${i.release}` : "").padEnd(24)} ${i.url ?? ""}${i.system ? "  (system)" : ""}${i.error ? `  error: ${i.error}` : ""}`;
const repoLine = (r: Repo) => `  ${r.fullName.padEnd(36)} -> ${(r.instanceName ?? r.instance).padEnd(24)} ${r.status.padEnd(8)}${r.private ? " private" : ""}${r.templateName ? `  from ${r.templateName}` : ""}${r.system ? "  (system)" : ""}`;

// ---- the verbs -------------------------------------------------------------------------------------------------
/** runs one verb; prints plain lines (or the raw result with --json) and returns the exit code */
export async function runCloud(sub: string | undefined, rest: string[], flags: Record<string, string>, io: Io = { out: console.log, err: console.error, isTTY: !!process.stdin.isTTY }): Promise<number> {
  const json = "json" in flags;
  const emit = (result: unknown, lines: () => string[]) => { if (json) io.out(JSON.stringify(result, null, 2)); else for (const l of lines()) io.out(l); };
  const log = json ? () => undefined : (l: string) => io.out(`  ${l}`);
  try {
    switch (sub) {
      case "login": {
        if (!flags.token) { io.err(TOKEN_HELP); return 2; }
        const url = (flags.url ?? DEFAULT_URL).replace(/\/$/, "");
        const s: Session = { url, token: flags.token, client: new CloudClient(url, () => flags.token!) };
        const m = await me(s); // the token is stored once it is known to work
        const p = writeConfig({ url, token: flags.token });
        emit({ url, user: m.user, path: p }, () => [`signed in to ${url} as ${m.user.email}${m.user.name ? ` (${m.user.name})` : ""}; session kept in ${p}`]);
        return 0;
      }
      case "logout": { const had = removeConfig(); emit({ removed: had, path: configPath() }, () => [had ? `signed out: ${configPath()} removed` : `not signed in (no ${configPath()})`]); return 0; }
      case "whoami": {
        const s = session(flags); const m = await me(s); const gh = await github(s);
        const c = m.connection;
        emit({ url: s.url, me: m, github: gh }, () => [
          `site:        ${s.url}`,
          `user:        ${m.user.email}${m.user.name ? ` (${m.user.name})` : ""}  id ${m.user.id}${m.admin ? "  admin" : ""}${m.user.superuser ? "  superuser" : ""}`,
          `cloudflare:  ${m.connected && c ? `connected as ${c.email || c.name || c.cfUserId || "?"}${c.scopes ? `, scopes ${c.scopes}` : ""}${c.expiry ? `, expires ${c.expiry}` : ""}` : m.providerConfigured === false ? "not configured on this site" : "not connected (connect Cloudflare on the cloud page)"}`,
          ...(c?.accounts?.length ? [`  accounts:  ${c.accounts.map((a) => `${a.name ?? ""} (${a.id})`.trim()).join(", ")}`] : []),
          `github:      ${!gh ? "unknown (the site did not answer /api/vbcloud/github)" : !gh.configured ? "not configured on this site" : gh.connected ? `connected as ${gh.connection?.login ?? "?"}` : "not connected (connect GitHub on the cloud page)"}`,
          ...(m.prefix ? [`instances:   named ${m.prefix}<name>${m.maxInstances ? `, up to ${m.maxInstances}` : ""}`] : []),
        ]);
        return 0;
      }
      case "instances": {
        const s = session(flags); const action = rest[0] ?? "ls"; const ref = rest[1];
        if (action === "ls" || action === "list") {
          const list = await instances(s);
          emit({ instances: list }, () => (list.length ? [`${list.length} instance(s) on ${s.url}:`, ...list.map(instanceLine)] : [`no instances on ${s.url} yet (voidbase cloud instances create <name>)`]));
          return 0;
        }
        if (action === "create") {
          if (!ref) throw new CliError("usage: voidbase cloud instances create <name> [--account id] [--email superuser@]", 2);
          const account = await pickAccount(s, flags.account);
          const email = flags.email ?? process.env.VOIDBASE_SUPERUSER_EMAIL ?? account.me.user.email;
          if (!email) throw new CliError("say who the superuser is: --email you@example.com", 2);
          const r = await s.client.createInstance({ name: ref, account: { id: account.id, name: account.name }, owner: account.me.user.id, superuserEmail: email, prefix: account.me.prefix, log });
          // the password is shown here, once: the client keeps it nowhere and the site never sees it
          emit(r, () => [`created ${r.instance.name} on ${account.name ?? account.id} (${account.id}), release ${r.instance.release ?? "?"}`, `  url:       ${r.credentials.url}`, `  panel:     ${r.credentials.panel}`, `  superuser: ${r.credentials.superuserEmail}`, `  password:  ${r.credentials.superuserPassword}   (shown once, kept nowhere: write it down)`]);
          return 0;
        }
        if (!ref) throw new CliError(`usage: voidbase cloud instances ${action} <name>`, 2);
        const inst = pickInstance(await instances(s), ref);
        if (action === "upgrade") {
          const r = await s.client.upgradeInstance(inst, { log });
          emit(r, () => [r.upgraded ? `upgraded ${inst.name} from ${r.from || "?"} to ${r.to}` : `${inst.name} is already on ${r.to}`]);
          return 0;
        }
        if (action === "delete" || action === "rm" || action === "destroy") {
          if (!json) io.out(`This deletes ${inst.name} on account ${inst.account.name || inst.account.id}: the Worker, its database, its bucket and everything in it, its queue and its custom domains. There is no undo, and no backup is taken.`);
          if (!("yes" in flags)) { // a destructive verb waits, unless the caller has already decided
            if (!io.isTTY || !io.confirm) throw new CliError("refusing to delete without a confirmation: rerun with --yes");
            const typed = (await io.confirm(`Type the instance name to confirm: `)).trim();
            if (typed !== inst.name) throw new CliError(`"${typed}" is not "${inst.name}": nothing deleted`);
          }
          const r = await s.client.deleteInstance(inst, { log });
          emit(r, () => [`deleted ${inst.name}: ${r.deleted.length} removed, ${r.skipped.length} not there`]);
          return 0;
        }
        throw new CliError(`unknown instances verb "${action}"\n${USAGE}`, 2);
      }
      case "repos": {
        const s = session(flags); const action = rest[0] ?? "ls";
        if (action === "ls" || action === "list") {
          const list = await repos(s);
          emit({ repos: list }, () => (list.length ? [`${list.length} repositor${list.length === 1 ? "y" : "ies"} on ${s.url}:`, ...list.map(repoLine)] : [`no repositories linked on ${s.url} yet (voidbase cloud repos create | link)`]));
          return 0;
        }
        if (action === "create") {
          if (!rest[1] || !flags.template || !flags.name) throw new CliError("usage: voidbase cloud repos create <instance> --template <name> --name <repo> [--private] [--inputs k=v,k=v]", 2);
          const [m, list, tpls] = await Promise.all([me(s), instances(s), templates(s)]);
          const inst = pickInstance(list, rest[1]); const template = pickTemplate(tpls, flags.template);
          const r = await s.client.createRepo({ template, name: flags.name, private: "private" in flags, instance: inst, user: m.user.id, inputs: parseInputs(flags.inputs) });
          emit(r, () => [`created ${r.repo.fullName} from ${template.name}${r.repo.private ? " (private)" : ""}, linked to ${inst.name}`, `  ${r.repo.htmlUrl}`, ...(Object.keys(r.variables).length ? [`  variables: ${Object.entries(r.variables).map(([k, v]) => `${k}=${v}`).join(", ")}`] : []), `  wired on the instance: ${r.wired.length ? r.wired.join(", ") : "nothing (the site could not put the GitHub token on the Worker)"}`]);
          return 0;
        }
        if (action === "link") {
          if (!rest[1] || !rest[2]) throw new CliError("usage: voidbase cloud repos link <instance> <owner/name> [--template name] [--inputs k=v,k=v]", 2);
          const [m, list] = await Promise.all([me(s), instances(s)]);
          const inst = pickInstance(list, rest[1]); const template = flags.template ? pickTemplate(await templates(s), flags.template) : undefined;
          const r = await s.client.linkRepo({ fullName: rest[2], instance: inst, user: m.user.id, template, inputs: parseInputs(flags.inputs) });
          emit(r, () => [`linked ${r.repo.fullName} to ${inst.name}`, ...(Object.keys(r.variables).length ? [`  variables: ${Object.entries(r.variables).map(([k, v]) => `${k}=${v}`).join(", ")}`] : []), `  wired on the instance: ${r.wired.length ? r.wired.join(", ") : "nothing (the site could not put the GitHub token on the Worker)"}`]);
          return 0;
        }
        if (action === "unlink") {
          if (!rest[1]) throw new CliError("usage: voidbase cloud repos unlink <owner/name>", 2);
          const [list, insts] = await Promise.all([repos(s), instances(s)]);
          const repo = pickRepo(list, rest[1]); const inst = insts.find((i) => i.id === repo.instance) ?? null;
          await s.client.unlinkRepo(repo, inst);
          emit({ unlinked: repo.fullName, instance: inst?.name ?? repo.instance }, () => [`unlinked ${repo.fullName} from ${inst?.name ?? repo.instance}; the repository stays on GitHub`]);
          return 0;
        }
        throw new CliError(`unknown repos verb "${action}"\n${USAGE}`, 2);
      }
      case "plugins": {
        const s = session(flags); const usage = "usage: voidbase cloud plugins <instance> [ls | install <name>[@version] [--marketplace url] | remove <name> [--yes] | update [name]] --email superuser@ --password ..";
        if (!rest[0]) throw new CliError(usage, 2);
        const inst = pickInstance(await instances(s), rest[0]);
        if (!inst.url) throw new CliError(`${inst.name} has no URL yet (status ${inst.status}): nothing to sign in to`);
        const email = flags.email ?? process.env.VOIDBASE_SUPERUSER_EMAIL ?? inst.superuserEmail; const password = flags.password ?? process.env.VOIDBASE_SUPERUSER_PASSWORD;
        if (!email || !password) throw new CliError(`the instance's own superuser signs in for this: --email and --password (or VOIDBASE_SUPERUSER_EMAIL / _PASSWORD)\n${usage}`, 2);
        const api = s.client.plugins(inst, await s.client.instanceSession(inst, email, password));
        const action = rest[1] ?? "ls";
        if (action === "ls" || action === "list") {
          const r = await api.running();
          emit(r, () => [
            `running:      ${r.names.map((n) => (r.origins[n] && r.origins[n] !== "shipped" ? `${n} (${r.origins[n]})` : n)).join(", ") || "none"}`,
            `disabled:     ${r.disabled.length ? r.disabled.join(", ") : "none"}`,
            // the instance answers this one itself even with no installer plugin loaded, but the answer is the
            // instance's and not ours: an older one, or one whose plugins are its own, may leave the field out
            `installer:    ${r.installer ? `${r.installer.mode}${r.installer.repository ? ` ${r.installer.repository}${r.installer.branch ? ` (${r.installer.branch})` : ""}` : ""}${r.installer.hint ? `  ${r.installer.hint}` : ""}` : "not reported by this instance"}`,
          ]);
          return 0;
        }
        const after = (r: Record<string, unknown>) => [String(r.message ?? r.applied ?? "done"), ...(r.committed ? [`  commit: ${(r.committed as { url?: string; sha?: string }).url ?? (r.committed as { sha?: string }).sha ?? ""}`] : [])];
        if (action === "install" || action === "add") { if (!rest[2]) throw new CliError(usage, 2); const spec = parseSpec(rest[2]); const r = await api.install(spec.name, { version: spec.version, marketplace: flags.marketplace }); emit(r, () => [`installed ${spec.name}${spec.version ? ` ${spec.version}` : ""} on ${inst.name}: ${after(r).join(" ")}`]); return 0; }
        if (action === "remove" || action === "rm") { if (!rest[2]) throw new CliError(usage, 2); const r = await api.remove(rest[2], { force: "yes" in flags }); emit(r, () => [`removed ${rest[2]} from ${inst.name}: ${after(r).join(" ")}`]); return 0; }
        if (action === "update") { const r = await api.update(rest[2]); emit(r, () => [`updated ${rest[2] ?? "the installed plugins"} on ${inst.name}: ${after(r).join(" ")}`]); return 0; }
        throw new CliError(`unknown plugins verb "${action}"\n${usage}`, 2);
      }
      case undefined: case "help": io.err(USAGE); return 2;
      default: throw new CliError(`unknown cloud verb "${sub}"\n${USAGE}`, 2);
    }
  } catch (err) {
    if (err instanceof CliError) { io.err(err.message); return err.code; }
    if (err instanceof CloudError) { if (!json) for (const l of err.log) io.err(`  ${l}`); io.err(err.message); return 1; }
    io.err(err instanceof Error ? err.message : String(err)); return 1;
  }
}
