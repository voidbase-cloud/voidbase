// The voidbase.cloud client: what the cloud page does, as one class that runs anywhere fetch exists (a browser,
// Bun, the prebuilt executable). Exported as `@voidbase-cloud/voidbase/cloud-client`; the site's page and
// `voidbase cloud <verb>` (src/node/cloud-cli.ts) both hold one.
//
// The site keeps the user's sign-in, their sealed Cloudflare and GitHub tokens and the rows about their instances
// and repositories; everything else happens here, with voidbase's own REST code: an instance is provisioned,
// upgraded and deleted with `./rest` against the user's Cloudflare account (through /api/vbcloud/cf, since
// Cloudflare's API sends no CORS headers; the token stays on the site), a repository is created, linked and
// unlinked against GitHub (through /api/vbcloud/gh), the rows are written through the collections' rules, and an
// instance's plugins, logs and superusers are read and changed on the instance itself, with a session the user
// mints on it; its custom domains and its Worker's secrets go through the Cloudflare pass-through like the
// provisioning. The one thing the client asks the site to do for it is to put the GitHub token on an instance's
// Worker (`wire`), because that token never leaves the site.
//
// Browser-safe on purpose: plain fetch, no node imports.
import { attachCustomDomain, CfApi, destroyInstance, listCustomDomains, provisionInstance, workerExists, type CustomDomain, type ReleaseManifest, type ReleaseSource } from "./rest";

export interface Instance { id: string; name: string; url?: string; status: string; error?: string; release?: string; account: { id: string; name?: string }; owner?: string; system?: boolean; self?: boolean; superuserEmail?: string; plugins?: unknown[]; canDelete?: boolean; canLink?: boolean }
export interface Repo { id: string; instance: string; fullName: string; htmlUrl: string; defaultBranch?: string; status: string; system?: boolean; private?: boolean; template?: string; templateName?: string; templateTitle?: string; canUnlink?: boolean; instanceName?: string; instanceUrl?: string }
export interface Template { id: string; name: string; repo: string; title: string; kind: string; variables: { name: string; source: string; value?: string }[] }
export interface Credentials { url: string; superuserEmail: string; superuserPassword?: string; panel: string }
export interface LogEntry { id: string; created: string; level: number; message: string; data?: Record<string, unknown> }
export interface LogPage { page: number; perPage: number; totalItems: number; totalPages: number; items: LogEntry[] }
export interface Superuser { id: string; email: string; created?: string }
/** one hour of the instance's logs: how many requests it answered, and how many of them it logged as errors */
export interface MetricsHour { date: string; total: number; errors: number }
export interface Metrics { hours: MetricsHour[]; totals: { requests: number; errors: number } }
/** one archive in the instance's backups storage, as PocketBase's backups API lists it */
export interface Backup { key: string; modified: string; size: number }
export interface Zone { id: string; name: string }
export interface WorkerSecret { name: string; managed: boolean }
export type { CustomDomain };
/** carried over rather than resupplied on an upgrade: what the instance was given when it was created */
const INHERITED = ["VOIDBASE_SUPERUSER_EMAIL", "VOIDBASE_SUPERUSER_PASSWORD"];
/** the Worker's secrets this site manages (creation, wiring): listed, never set or removed from the page */
const MANAGED = (name: string) => /^VOIDBASE_SUPERUSER_|^VOIDBASE_PROJECT_|^VOIDBASE_GH_TOKEN$/.test(name);
/** PocketBase's log levels, as the logs API numbers them */
export const LOG_LEVELS: Record<number, string> = { [-4]: "debug", 0: "info", 4: "warn", 8: "error" };
/** what PocketBase accepts as a backup file name */
const BACKUP_NAME = /^[a-z0-9_-]+\.zip$/;

export class CloudError extends Error { constructor(message: string, public status = 400, public log: string[] = []) { super(message); } }
const randomPassword = () => { const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => a[b % a.length]).join(""); };

export class CloudClient {
  constructor(private base: string, private token: () => string, private fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)) { this.base = base.replace(/\/$/, ""); }

  // ---- the site ----------------------------------------------------------------------------------------------
  private async site<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    const r = await this.fetchImpl(`${this.base}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: this.token() }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) { if (!r.ok) throw new CloudError(`${path}: ${r.status}`, r.status); return (await r.arrayBuffer()) as unknown as T; }
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new CloudError(String(json.message ?? `${path}: ${r.status}`), r.status);
    return json as T;
  }
  private record = <T>(collection: string, method: string, id?: string, body?: unknown) => this.site<T>(method, `/api/collections/${collection}/records${id ? `/${id}` : ""}`, body);
  /**
   * Cloudflare's API in the user's account: voidbase's own client, pointed at the site's pass-through. A call that
   * carries its own bearer (an asset upload's session token) sends it as x-cf-token, and the pass-through uses that
   * one instead of the user's.
   */
  cf(): CfApi {
    const site = this;
    // through the client's own fetch, so a test's fake fetch sees these calls like every other
    class Proxied extends CfApi { override raw(method: string, path: string, init: { body?: BodyInit | null; headers?: Record<string, string>; token?: string } = {}) { return site.fetchImpl(`${this.base}${path}`, { method, body: init.body ?? null, headers: { authorization: `Bearer ${site.token()}`, ...(init.headers ?? {}), ...(init.token ? { "x-cf-token": init.token } : {}) } }); } }
    return new Proxied(this.token(), `${this.base}/api/vbcloud/cf`);
  }
  /** GitHub's API with the user's connection, through the site's pass-through */
  async gh<T>(method: string, path: string, body?: unknown, tolerate: number[] = []): Promise<{ status: number; data: T }> {
    const r = await this.fetchImpl(`${this.base}/api/vbcloud/gh${path}`, { method, headers: { authorization: this.token(), accept: "application/vnd.github+json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
    if (!r.ok && !tolerate.includes(r.status)) throw new CloudError(`GitHub ${method} ${path}: ${r.status} ${(data as { message?: string } | null)?.message ?? ""}`.trim(), r.status);
    return { status: r.status, data: data as T };
  }

  // ---- releases ----------------------------------------------------------------------------------------------
  /** the active release, readable file by file from the site */
  async release(version?: string): Promise<ReleaseSource & { version: string }> {
    const v = version ?? (await this.site<{ current: string | null }>("GET", "/api/vbcloud/release")).current;
    if (!v) throw new CloudError("No voidbase release is available on this site yet.");
    const manifest = JSON.parse(new TextDecoder().decode(await this.site<ArrayBuffer>("GET", `/api/vbcloud/releases/${v}/files?path=manifest.json`, undefined, true))) as ReleaseManifest;
    return { version: v, manifest, read: async (path) => new Uint8Array(await this.site<ArrayBuffer>("GET", `/api/vbcloud/releases/${v}/files?path=${encodeURIComponent(path)}`, undefined, true)) };
  }

  // ---- instances: the user's own Worker, in the user's account ---------------------------------------------
  async createInstance(o: { name: string; account: { id: string; name?: string }; owner: string; superuserEmail: string; prefix?: string; log?: (l: string) => void }): Promise<{ instance: Instance; credentials: Credentials; log: string[] }> {
    const prefix = o.prefix ?? "vb-";
    const wanted = o.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!wanted) throw new CloudError("Give the instance a name (letters, digits, dashes).");
    const name = wanted.startsWith(prefix) ? wanted : `${prefix}${wanted}`;
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new CloudError(`"${name}" is not a valid worker name (lowercase letters, digits and dashes, 63 chars max).`);
    const cf = this.cf();
    if (await workerExists(cf, o.account.id, name)) throw new CloudError(`A Worker named ${name} already exists on that account.`);
    const release = await this.release();
    const password = randomPassword();
    const row = await this.record<{ id: string }>("vb_instances", "POST", undefined, { owner: o.owner, name, account_id: o.account.id, account_name: o.account.name ?? "", status: "creating", release: release.version, superuser_email: o.superuserEmail });
    const lines: string[] = []; const log = (l: string) => { lines.push(l); o.log?.(l); };
    try {
      const r = await provisionInstance(cf, { account: o.account.id, name, release, superuser: { email: o.superuserEmail, password }, applyDoMigrations: true, tags: [`vbcloud-owner:${o.owner}`], log });
      await this.record("vb_instances", "PATCH", row.id, { status: "live", url: r.url ?? "", d1_id: r.d1.uuid, queue_id: r.queue?.id ?? "", error: "" });
      const instance: Instance = { id: row.id, name, url: r.url ?? "", status: "live", release: release.version, account: { id: o.account.id, name: o.account.name ?? "" }, owner: o.owner, superuserEmail: o.superuserEmail, canDelete: true, canLink: true };
      // the superuser password travels to the new Worker as a secret and to the owner once, here; it is kept nowhere
      return { instance, credentials: { url: r.url ?? "", superuserEmail: o.superuserEmail, superuserPassword: password, panel: r.url ? `${r.url}/_/` : "" }, log: lines };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.record("vb_instances", "PATCH", row.id, { status: "error", error: message.slice(0, 1000) }).catch(() => null);
      throw new CloudError(`Creating ${name} failed: ${message}`, 400, lines);
    }
  }

  async deleteInstance(inst: Instance, o: { log?: (l: string) => void } = {}): Promise<{ deleted: string[]; skipped: string[]; errors: string[]; log: string[] }> {
    if (inst.system) throw new CloudError("A system instance is not deleted from here.");
    await this.record("vb_instances", "PATCH", inst.id, { status: "deleting" });
    const lines: string[] = []; const log = (l: string) => { lines.push(l); o.log?.(l); };
    const report = await destroyInstance(this.cf(), { account: inst.account.id, name: inst.name, log });
    if (report.errors.length) { await this.record("vb_instances", "PATCH", inst.id, { status: "error", error: report.errors.join("; ").slice(0, 1000) }).catch(() => null); throw new CloudError(`Deleting ${inst.name} left errors: ${report.errors.join("; ")}`, 400, lines); }
    await this.record("vb_instances", "DELETE", inst.id);
    return { deleted: report.deleted, skipped: report.skipped, errors: report.errors, log: lines };
  }

  /** the active release, in place: same data, same secrets, same domains; the code changes */
  async upgradeInstance(inst: Instance, o: { log?: (l: string) => void } = {}): Promise<{ upgraded: boolean; from: string; to: string; log: string[] }> {
    if (inst.system) throw new CloudError("A system instance is deployed from its repository; upgrade it there.");
    const release = await this.release(); const from = inst.release ?? ""; const to = release.version;
    if (from === to) return { upgraded: false, from, to, log: [] };
    const cf = this.cf();
    if (!(await workerExists(cf, inst.account.id, inst.name))) throw new CloudError("The Worker for this instance is not on the account any more.");
    await this.record("vb_instances", "PATCH", inst.id, { status: "upgrading" });
    const lines: string[] = []; const log = (l: string) => { lines.push(l); o.log?.(l); };
    try {
      await provisionInstance(cf, { account: inst.account.id, name: inst.name, release, inheritSecrets: INHERITED, applyDoMigrations: false, tags: [`vbcloud-owner:${inst.owner ?? ""}`], log });
      await this.record("vb_instances", "PATCH", inst.id, { release: to, status: "live", error: "" });
      return { upgraded: true, from, to, log: lines };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.record("vb_instances", "PATCH", inst.id, { status: inst.status || "live", error: message.slice(0, 1000) }).catch(() => null);
      throw new CloudError(`Upgrading ${inst.name} failed: ${message}`, 400, lines);
    }
  }

  /**
   * Whether the instance's Worker has a Workers Builds trigger, so a push to its repository deploys it. Connecting
   * the repository (which installs Cloudflare's GitHub App for it) is the one step only the dashboard can do; the
   * link goes straight to it. null when the user's token cannot read builds.
   */
  async pipelineOf(inst: Instance): Promise<{ connected: boolean | null; link: string }> {
    const link = `https://dash.cloudflare.com/${inst.account.id}/workers/services/view/${inst.name}/settings`;
    try {
      const cf = this.cf();
      const tag = (await cf.json<{ id: string; tag?: string }[]>("GET", `/accounts/${inst.account.id}/workers/scripts`)).result?.find((s) => s.id === inst.name)?.tag;
      if (!tag) return { connected: null, link };
      const triggers = (await cf.json<{ trigger_uuid: string }[]>("GET", `/accounts/${inst.account.id}/builds/workers/${tag}/triggers`)).result ?? [];
      return { connected: triggers.length > 0, link };
    } catch { return { connected: null, link }; }
  }

  credentials(inst: Instance): Credentials { return { url: inst.url ?? "", superuserEmail: inst.superuserEmail ?? "", panel: inst.url ? `${inst.url}/_/` : "" }; }

  // ---- repositories: the user's GitHub, wired to their instance --------------------------------------------
  private variable = (source: string, inst: Instance, input: Record<string, unknown>, literal?: string): string => {
    if (source === "instance_url") return inst.url ?? "";
    if (source === "instance_panel") return inst.url ? `${inst.url}/_/` : "";
    if (source === "instance_name") return inst.name;
    if (source.startsWith("input:")) return String(input[source.slice(6)] ?? "").trim();
    return literal ?? "";
  };
  private async setVariable(fullName: string, name: string, value: string) {
    const r = await this.gh("POST", `/repos/${fullName}/actions/variables`, { name, value }, [409]);
    if (r.status === 409) await this.gh("PATCH", `/repos/${fullName}/actions/variables/${name}`, { name, value });
  }
  private wire = (inst: Instance, repo: { fullName: string; branch: string }) => this.site<{ wired: string[] }>("POST", `/api/vbcloud/instances/${inst.id}/wire`, { repository: repo.fullName, branch: repo.branch }).catch(() => ({ wired: [] as string[] }));

  async createRepo(o: { template: Template; name: string; owner?: string; private?: boolean; description?: string; instance: Instance; user: string; inputs?: Record<string, unknown> }): Promise<{ repo: Repo; variables: Record<string, string>; wired: string[] }> {
    const name = o.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    if (!name || name.length > 100) throw new CloudError("Give the repository a name (letters, digits, dashes, dots, underscores).");
    const login = o.owner ?? (await this.gh<{ login: string }>("GET", "/user")).data.login;
    const made = await this.gh<{ full_name: string; html_url: string; default_branch: string; private: boolean }>("POST", `/repos/${o.template.repo}/generate`, { owner: login, name, private: !!o.private, description: o.description ?? `${o.template.title} on voidbase (${o.instance.name})` });
    const variables: Record<string, string> = {};
    for (const v of o.template.variables ?? []) { const value = this.variable(v.source, o.instance, o.inputs ?? {}, v.value); if (!value) continue; await this.setVariable(made.data.full_name, v.name, value); variables[v.name] = value; }
    const row = await this.record<{ id: string }>("vb_repos", "POST", undefined, { user: o.user, instance: o.instance.id, template: o.template.id, full_name: made.data.full_name.toLowerCase(), html_url: made.data.html_url, default_branch: made.data.default_branch ?? "main", private: !!made.data.private, status: "ready" });
    const { wired } = await this.wire(o.instance, { fullName: made.data.full_name.toLowerCase(), branch: made.data.default_branch ?? "main" });
    return { repo: { id: row.id, instance: o.instance.id, fullName: made.data.full_name.toLowerCase(), htmlUrl: made.data.html_url, defaultBranch: made.data.default_branch, status: "ready", private: !!made.data.private, template: o.template.id, templateName: o.template.name, templateTitle: o.template.title, canUnlink: true, instanceName: o.instance.name, instanceUrl: o.instance.url }, variables, wired };
  }

  async linkRepo(o: { fullName: string; instance: Instance; user: string; template?: Template; inputs?: Record<string, unknown> }): Promise<{ repo: Repo; variables: Record<string, string>; wired: string[] }> {
    const fullName = o.fullName.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9._-]+$/.test(fullName)) throw new CloudError("Give the repository as owner/name (or its GitHub URL).");
    const repo = await this.gh<{ full_name: string; html_url: string; default_branch: string; private: boolean; permissions?: { push?: boolean } }>("GET", `/repos/${fullName}`, undefined, [404]);
    if (repo.status === 404) throw new CloudError(`${fullName} was not found on GitHub with your connection (does the account have access to it?).`);
    if (repo.data.permissions && repo.data.permissions.push === false) throw new CloudError(`You cannot write to ${fullName}, so its variables cannot be set.`);
    const vars = [...(o.template?.variables ?? [])]; if (!vars.some((v) => v.name === "PB_VB_URL")) vars.unshift({ name: "PB_VB_URL", source: "instance_url" });
    const variables: Record<string, string> = {};
    for (const v of vars) { if (!v.source.startsWith("instance_") && !(v.source.startsWith("input:") && o.inputs?.[v.source.slice(6)])) continue; const value = this.variable(v.source, o.instance, o.inputs ?? {}, v.value); if (!value) continue; await this.setVariable(repo.data.full_name, v.name, value); variables[v.name] = value; }
    const row = await this.record<{ id: string }>("vb_repos", "POST", undefined, { user: o.user, instance: o.instance.id, template: o.template?.id ?? "", full_name: repo.data.full_name.toLowerCase(), html_url: repo.data.html_url, default_branch: repo.data.default_branch ?? "", private: !!repo.data.private, status: "ready" });
    const { wired } = await this.wire(o.instance, { fullName: repo.data.full_name.toLowerCase(), branch: repo.data.default_branch ?? "master" });
    return { repo: { id: row.id, instance: o.instance.id, fullName: repo.data.full_name.toLowerCase(), htmlUrl: repo.data.html_url, defaultBranch: repo.data.default_branch, status: "ready", private: !!repo.data.private, template: o.template?.id, templateName: o.template?.name, templateTitle: o.template?.title, canUnlink: true, instanceName: o.instance.name, instanceUrl: o.instance.url }, variables, wired };
  }

  /** unlinks only: the repository stays in the user's GitHub; the instance forgets it */
  async unlinkRepo(repo: Repo, inst?: Instance | null): Promise<void> {
    if (repo.system) throw new CloudError("A system repository stays linked.");
    await this.record("vb_repos", "DELETE", repo.id);
    if (inst && !inst.system) await this.site("DELETE", `/api/vbcloud/instances/${inst.id}/wire`).catch(() => null);
  }
  /** what GitHub says about a linked repository now */
  async checkRepo(repo: Repo, inst?: Instance | null): Promise<{ exists: boolean; connected: boolean; backendUrl: string; private?: boolean; defaultBranch?: string }> {
    const r = await this.gh<{ default_branch: string; private: boolean }>("GET", `/repos/${repo.fullName}`, undefined, [404]);
    if (r.status === 404) return { exists: false, connected: false, backendUrl: "" };
    const v = await this.gh<{ value?: string }>("GET", `/repos/${repo.fullName}/actions/variables/PB_VB_URL`, undefined, [404]);
    const value = v.status === 404 ? "" : String(v.data?.value ?? "");
    return { exists: true, connected: !!inst?.url && value === inst.url, backendUrl: value, private: r.data.private, defaultBranch: r.data.default_branch };
  }

  // ---- the instance itself, with a session minted on it: plugins, logs, superusers ------------------------
  async instanceSession(inst: Instance, email: string, password: string): Promise<string> {
    const r = await this.fetchImpl(`${(inst.url ?? "").replace(/\/+$/, "")}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: email, password }) });
    const j = (await r.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!r.ok || !j.token) throw new CloudError(j.message ?? `The instance refused the sign-in (${r.status}).`, r.status);
    return j.token;
  }
  /** one call on the instance's own API with the owner's session; the instance's answer is the answer */
  private onInstance(inst: Instance, session: string) {
    const base = (inst.url ?? "").replace(/\/+$/, "");
    return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const r = await this.fetchImpl(`${base}${path}`, { method, headers: { authorization: session, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 204) return {} as T;
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new CloudError(String(j.message ?? `${path}: ${r.status}`), r.status);
      return j as T;
    };
  }
  plugins(inst: Instance, session: string) {
    const call = this.onInstance(inst, session);
    return {
      // `installer` is optional, and so is its `mode`, because this types what an instance answers rather than what
      // this client builds: a voidbase instance always answers the field (the core answers when no plugin does),
      // but this talks to instances of any version over HTTP, and an instance whose installer is an installed
      // plugin answers `{error}` for it when that plugin could not describe itself. A reader has to test the field
      // it is about to read, not the object around it.
      running: () => call<{ names: string[]; origins: Record<string, string>; disabled: string[]; installer?: { mode?: string; repository?: string; branch?: string; hint?: string; error?: string } }>("GET", "/api/plugins"),
      available: (marketplace?: string) => call<{ available: { marketplace: string; plugins: { name: string; title: string; summary: string; latest: string }[]; error?: string }[] }>("GET", `/api/plugins/available${marketplace ? `?marketplace=${encodeURIComponent(marketplace)}` : ""}`),
      install: (name: string, o: { version?: string; marketplace?: string } = {}) => call<Record<string, unknown>>("POST", "/api/plugins/install", { name, ...o }),
      // the instance answers 409 for a core plugin, or one something else requires, until force says it was meant
      remove: (name: string, o: { force?: boolean } = {}) => call<Record<string, unknown>>("POST", "/api/plugins/remove", o.force ? { name, force: true } : { name }),
      update: (name?: string) => call<Record<string, unknown>>("POST", "/api/plugins/update", name ? { name } : {}),
    };
  }
  /** the instance's own logs (PocketBase's logs API): newest first, filtered with PocketBase's filter syntax */
  logs(inst: Instance, session: string) {
    const call = this.onInstance(inst, session);
    return {
      list: (o: { filter?: string; sort?: string; page?: number; perPage?: number } = {}) => {
        const q = new URLSearchParams({ page: String(o.page ?? 1), perPage: String(o.perPage ?? 50), sort: o.sort ?? "-created" });
        if (o.filter?.trim()) q.set("filter", o.filter.trim());
        return call<LogPage>("GET", `/api/logs?${q}`);
      },
      stats: (filter?: string) => call<{ total: number; date: string }[]>("GET", `/api/logs/stats${filter?.trim() ? `?filter=${encodeURIComponent(filter.trim())}` : ""}`),
    };
  }
  /**
   * Requests and errors over the last 24 hours, from the instance's own logs: PocketBase's stats endpoint counts
   * entries per hour, once for everything and once for the entries at the error level, joined here by hour.
   */
  async metrics(inst: Instance, session: string): Promise<Metrics> {
    const api = this.logs(inst, session);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace("T", " ");
    const bound = `created >= "${since}"`;
    const [requests, errors] = await Promise.all([api.stats(bound), api.stats(`${bound} && level >= 8`)]);
    const byHour = new Map<string, MetricsHour>();
    for (const b of requests) byHour.set(b.date, { date: b.date, total: b.total || 0, errors: 0 });
    for (const b of errors) { const h = byHour.get(b.date) ?? { date: b.date, total: b.total || 0, errors: 0 }; h.errors = b.total || 0; byHour.set(b.date, h); }
    const hours = [...byHour.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { hours, totals: { requests: hours.reduce((n, h) => n + h.total, 0), errors: hours.reduce((n, h) => n + h.errors, 0) } };
  }
  /**
   * The instance's backups (PocketBase's backups API): archives in its own storage. A restore replaces the
   * instance's collections, rows and files with the archive's and restarts it. A download is a file token minted
   * on the instance, then the archive's URL with that token, for a new tab.
   */
  backups(inst: Instance, session: string) {
    const call = this.onInstance(inst, session);
    const base = (inst.url ?? "").replace(/\/+$/, "");
    return {
      list: async (): Promise<Backup[]> => { const r = await call<Backup[] | Record<string, unknown>>("GET", "/api/backups"); return Array.isArray(r) ? r : []; },
      create: async (name?: string): Promise<{ name: string }> => {
        let n = (name ?? "").trim().toLowerCase();
        if (n && !n.endsWith(".zip")) n += ".zip";
        if (n && !BACKUP_NAME.test(n)) throw new CloudError("A backup name is lowercase letters, digits, dashes and underscores, ending in .zip.");
        await call("POST", "/api/backups", n ? { name: n } : {});
        return { name: n };
      },
      remove: async (key: string) => { await call("DELETE", `/api/backups/${encodeURIComponent(key)}`); },
      restore: async (key: string) => { await call("POST", `/api/backups/${encodeURIComponent(key)}/restore`); },
      downloadUrl: async (key: string) => {
        const { token } = await call<{ token?: string }>("POST", "/api/files/token");
        if (!token) throw new CloudError("The instance did not give a file token.");
        return `${base}/api/backups/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;
      },
    };
  }
  /** the instance's superusers (_superusers): who can open its panel; the last one stays */
  superusers(inst: Instance, session: string) {
    const call = this.onInstance(inst, session);
    const list = async () => (await call<{ items: Superuser[] }>("GET", "/api/collections/_superusers/records?perPage=200&sort=created")).items ?? [];
    return {
      list,
      add: async (email: string, password: string) => {
        const e = email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new CloudError("Give the superuser an email address.");
        if (password.length < 8) throw new CloudError("A superuser password is at least 8 characters.");
        return call<Superuser>("POST", "/api/collections/_superusers/records", { email: e, password, passwordConfirm: password });
      },
      remove: async (id: string) => {
        const all = await list();
        if (all.length <= 1 && all.some((s) => s.id === id)) throw new CloudError("The last superuser stays: the instance would have nobody to sign in to its panel.");
        await call("DELETE", `/api/collections/_superusers/records/${id}`);
      },
    };
  }

  // ---- the instance's Worker, in the user's account: custom domains and secrets -----------------------------
  /** Workers Custom Domains on the instance's Worker: Cloudflare adds the DNS record and the certificate */
  domains(inst: Instance) {
    const cf = this.cf(); const account = inst.account.id;
    return {
      zones: async () => (await cf.json<Zone[]>("GET", `/zones?account.id=${account}&per_page=50`)).result?.map((z) => ({ id: z.id, name: z.name })) ?? [],
      list: () => listCustomDomains(cf, account, { service: inst.name }),
      attach: async (hostname: string, zoneId?: string) => {
        const h = hostname.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) throw new CloudError("Give a hostname like api.example.com, on a zone of this account.");
        return attachCustomDomain(cf, account, { hostname: h, service: inst.name, environment: "production", zoneId: zoneId || undefined });
      },
      detach: async (id: string) => { await cf.json("DELETE", `/accounts/${account}/workers/domains/${encodeURIComponent(id)}`); },
    };
  }
  /** the Worker's secrets by name: values are written and never read back; the ones this site manages stay */
  secrets(inst: Instance) {
    const cf = this.cf(); const base = `/accounts/${inst.account.id}/workers/scripts/${inst.name}/secrets`;
    const guard = (name: string) => { if (MANAGED(name)) throw new CloudError(`${name} is managed by voidbase.cloud and is not changed from here.`); };
    return {
      list: async (): Promise<WorkerSecret[]> => ((await cf.json<{ name: string }[]>("GET", base)).result ?? []).map((s) => ({ name: s.name, managed: MANAGED(s.name) })).sort((a, b) => a.name.localeCompare(b.name)),
      set: async (name: string, text: string) => {
        const n = name.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new CloudError("A secret name is letters, digits and underscores, and does not start with a digit.");
        guard(n); if (!text) throw new CloudError("Give the secret a value.");
        await cf.json("PUT", base, { name: n, text, type: "secret_text" });
      },
      remove: async (name: string) => { guard(name); await cf.json("DELETE", `${base}/${encodeURIComponent(name)}`); },
    };
  }
}
