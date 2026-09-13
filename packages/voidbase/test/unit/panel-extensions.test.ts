// The admin panel's Plugins page (src/panel/extensions.ts), run the way the panel runs its extensions file: against an
// `app` with a router, a store and the SDK, and `t` and `store` as globals. What is checked is what the page does with
// the instance's answers: the header link, the plugin list with where each came from, a plane editable on vanilla and
// read only when the project declares it, a save that sends only what changed, and what the page offers to change
// read item by item from where each item came from, which is how it tells a vanilla instance from an extended one.
import { expect, test } from "bun:test";
import { PANEL_EXTENSIONS } from "../../src/panel/extensions";

interface El { tag: string; props: Record<string, unknown>; children: unknown[] }
const t = new Proxy({}, { get: (_o, tag: string) => (props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }) as El });
/** a render with every reactive child and prop called once, the way the panel's first paint calls them */
const render = (n: unknown): unknown => {
  if (typeof n === "function") return render(n());
  if (Array.isArray(n)) return n.map(render);
  if (n && typeof n === "object" && "tag" in n) { const e = n as El; return { tag: e.tag, props: e.props, children: e.children.map(render) }; }
  return n;
};
const find = (n: unknown, pick: (e: El) => boolean, out: El[] = []): El[] => {
  if (Array.isArray(n)) n.forEach((c) => find(c, pick, out));
  else if (n && typeof n === "object" && "tag" in n) { if (pick(n as El)) out.push(n as El); (n as El).children.forEach((c) => find(c, pick, out)); }
  return out;
};
const text = (n: unknown): string => (Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" && "tag" in n ? (n as El).children.map(text).join("") : n == null ? "" : String(n));

type Answer = (options: Record<string, unknown>) => unknown;
async function openPage(planes: Record<string, unknown>, installer: Record<string, unknown> = { mode: "filesystem" }, pbPublic: Record<string, unknown> = {}, answers: Record<string, Answer> = {}) {
  const routes: Record<string, () => unknown> = {}; const sent: { path: string; options: Record<string, unknown> }[] = []; const toasts: string[] = []; const confirms: string[] = [];
  const app = {
    routes: { superuserOnly: (path: string, handler: () => unknown) => { routes[path] = handler; } },
    store: { headerLinks: [{ href: "#/collections" }, { href: "#/logs" }, { href: "#/settings" }], title: "" },
    components: {}, checkApiError: (err: unknown) => { throw err; },
    // the panel's own confirm: says yes at once, and remembers what it asked
    modals: { confirm: (message: string, yes: () => void) => { confirms.push(message); yes(); } },
    toasts: { success: (m: string) => toasts.push(m), info: (m: string) => toasts.push(m) },
    pb: { send: async (path: string, options: Record<string, unknown>) => {
      sent.push({ path, options });
      if (answers[path]) return answers[path]!(options);
      if (path === "/api/plugins") {
        const source = installer.mode === "filesystem" ? "instance" : "repository";
        return { installer, plugins: [{ name: "hardening", tier: "core", source: "voidbase", provides: ["hardening@1"] }, { name: "audit", tier: "community", source, provides: [] }], files: { pb_hooks: source, pb_migrations: source, pb_public: source } };
      }
      // a fresh answer on every call, the way a response is
      if (path === "/api/plugins/config") return structuredClone(planes);
      if (path === "/api/pb_public" && !options.method) return structuredClone(pbPublic);
      if (path === "/api/pb_public") return { written: ["logo.svg"], message: "Uploaded logo.svg. The instance serves it now." };
      if (path === "/api/automigrate") return { on: true, repository: null, pending: installer.pending ?? [] };
      return { message: "referrer_policy took effect." };
    } },
  };
  new Function("app", "t", "store", PANEL_EXTENSIONS)(app, t, (o: object) => o);
  const page = routes["#/plugins"]!();
  await new Promise((r) => setTimeout(r, 0));
  return { app, page, sent, toasts, confirms };
}

const click = (n: unknown, label: string) => { const b = find(n, (e) => e.tag === "button" && text(e) === label)[0]; if (!b) throw new Error("no button " + label); (b.props.onclick as () => void)(); };
const settle = () => new Promise((r) => setTimeout(r, 5));
const posted = (sent: { path: string; options: Record<string, unknown> }[], path: string) => sent.filter((x) => x.path === path && x.options.method === "POST").map((x) => x.options.body);
const STEPS = ["declare", "fetch", "assemble", "upload", "restart"];
const runOf = (id: number, status: string, steps: Record<string, string>, more: Record<string, unknown> = {}) => ({ id, reasons: ["install backups 0.1.0"], status, queuedAt: "2026-09-13T10:00:00Z", steps: STEPS.map((name) => ({ name, status: steps[name] ?? "pending", ...(steps[name] === "failed" ? { detail: "EACCES: permission denied, open 'pb_data/active/voidbase.lock'" } : {}) })), ...more });
const version = (number: number, plugins: Record<string, string>) => ({ number, at: "2026-09-13T1" + number + ":00:00Z", plugins: Object.fromEntries(Object.entries(plugins).map(([n, v]) => [n, { version: v, commit: n + v }])), disabled: [], from: number - 1 || null, run: number });

const hardening = { editable: true, fields: { referrer_policy: { type: "string", applies: "runtime", knob: "VOIDBASE_REFERRER_POLICY", value: "", source: "default" } } };
const observability = { editable: false, fields: { sample_rate: { type: "number", applies: "rebuild", knob: "VOIDBASE_OBSERVABILITY_SAMPLE", value: 1, source: "project", pending: 0.5 } } };

test("the panel gets a Plugins page listing what loaded and where each came from", async () => {
  const { app, page } = await openPage({ hardening, observability });
  expect(app.store.headerLinks.map((l) => l.href)).toEqual(["#/collections", "#/logs", "#/plugins", "#/settings"]);
  const shown = render(page);
  const rows = find(shown, (e) => e.tag === "tr" && !!e.props["data-plugin"]);
  expect(rows.map(text)).toEqual(["hardeningcoreShips with voidbaseNo: it ships with voidbasehardening@1", "auditcommunityInstalled on this instanceYesRemove"]);
});

test("the page knows what it may change item by item: vanilla changes what the instance holds, extended changes nothing", async () => {
  const vanilla = render((await openPage({ hardening })).page);
  expect(text(find(vanilla, (e) => e.tag === "p")[0])).toStartWith("Vanilla: this instance holds its own plugins and files");
  expect(find(vanilla, (e) => e.tag === "tr" && !!e.props["data-folder"]).map(text)).toEqual(["pb_hooksInstalled on this instanceYes", "pb_migrationsInstalled on this instanceYes", "pb_publicInstalled on this instanceYes"]);

  const extended = render((await openPage({ hardening }, { mode: "repository", repository: "me/app" })).page);
  expect(text(find(extended, (e) => e.tag === "p")[0])).toBe("Extended: the repository me/app declares this instance. The panel shows what it declares and changes none of it.");
  expect(find(extended, (e) => e.tag === "tr" && !!e.props["data-plugin"]).map(text)).toContain("auditcommunityDeclared in the repositoryNo: change it in the repository and commit");
  expect(find(extended, (e) => e.tag === "tr" && !!e.props["data-folder"]).map(text)[2]).toBe("pb_publicDeclared in the repositoryNo: change it in the repository and commit");
  // a plane the instance would accept is still read only on an extended instance, with nothing to save
  expect(find(extended, (e) => e.tag === "input").map((i) => i.props.disabled)).toEqual([true]);
  expect(text(find(extended, (e) => e.tag === "div" && e.props["data-plugin"] === "hardening")[0])).toContain("Read only: an extended instance is configured in its project");
  expect(find(extended, (e) => e.tag === "button")).toHaveLength(0);

  // a schema change automigrate could not get into the repository is on the page
  const pending = render((await openPage({}, { mode: "fixed", pending: [{ file: "1789000000_updated_vaults.js", collection: "vaults", change: "updated" }] })).page);
  expect(find(pending, (e) => e.tag === "li" && !!e.props["data-migration"]).map(text)).toEqual(["vaults updated: pb_migrations/1789000000_updated_vaults.js"]);
  const fixed = render((await openPage({}, { mode: "fixed" })).page);
  expect(text(find(fixed, (e) => e.tag === "p")[0])).toStartWith("Extended: this instance was built with its plugins and files.");
});

test("a plane the instance holds is editable, one the project declares is read only, and a rebuild field says it waits", async () => {
  const { page } = await openPage({ hardening, observability });
  const shown = render(page);
  const inputs = find(shown, (e) => e.tag === "input");
  expect(inputs.map((i) => [i.props.id, i.props.disabled])).toEqual([["plugin-config-hardening-referrer_policy", false], ["plugin-config-observability-sample_rate", true]]);
  const planes = find(shown, (e) => !!e.props["data-plugin"] && e.tag === "div");
  expect(text(planes[0])).toContain("Editable here");
  expect(text(planes[1])).toContain("Read only: the project declares it in pb_plugins/observability/config.json");
  expect(text(planes[1])).toContain("Waits for the next rebuild: 0.5.");
  expect(find(planes[1], (e) => e.tag === "button")).toHaveLength(0);
});

test("a vanilla instance uploads into pb_public from the page, and an extended one only lists it", async () => {
  const { page, sent, toasts } = await openPage({}, { mode: "filesystem" }, { source: "instance", editable: true, files: [{ path: "index.html", size: 12 }] });
  const shown = render(page);
  expect(find(shown, (e) => e.tag === "li" && !!e.props["data-public"]).map(text)).toEqual(["index.html 12 bytes"]);
  const chooser = find(shown, (e) => e.tag === "input" && e.props.type === "file")[0]!;
  const logo = new File(["<svg/>"], "logo.svg");
  (chooser.props.onchange as (e: unknown) => void)({ target: { files: [logo] } });
  (find(shown, (e) => e.tag === "button" && text(e) === "Upload to pb_public")[0]!.props.onclick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  const posted = sent.find((s) => s.path === "/api/pb_public" && s.options.method === "POST")!;
  expect((posted.options.body as FormData).getAll("files")).toEqual([logo]);
  expect(toasts).toEqual(["Uploaded logo.svg. The instance serves it now."]);

  const extended = render((await openPage({}, { mode: "repository", repository: "me/app" }, { source: "repository", editable: false, files: [{ path: "index.html", size: 12 }] })).page);
  expect(find(extended, (e) => e.tag === "input" && e.props.type === "file")).toHaveLength(0);
  expect(text(extended)).toContain("These files come from the project's repository: change them there and commit.");
});

test("saving sends only the fields that changed and says what the instance answered", async () => {
  const { page, sent, toasts } = await openPage({ hardening });
  const shown = render(page);
  const input = find(shown, (e) => e.tag === "input")[0]!;
  (input.props.oninput as (e: unknown) => void)({ target: { value: "no-referrer" } });
  click(shown, "Save hardening");
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.find((s) => s.path === "/api/plugins/config/hardening")?.options).toEqual({ method: "PATCH", body: { referrer_policy: "no-referrer" } });
  expect(toasts).toEqual(["referrer_policy took effect."]);
});

test("a vanilla instance shows the step a rebuild is on, and keeps reading it until it is done", async () => {
  let reads = 0;
  const running = { rebuilds: true, runs: [runOf(1, "running", { declare: "done", fetch: "done", assemble: "running" })], versions: [], current: null };
  const done = { rebuilds: true, runs: [runOf(1, "done", Object.fromEntries(STEPS.map((n) => [n, "done"])), { version: 1 })], versions: [version(1, { backups: "0.1.0" })], current: 1 };
  const { page } = await openPage({}, { mode: "filesystem" }, {}, { "/api/rebuilds": () => (reads++ === 0 ? running : done) });
  const shown = render(page);
  expect(find(shown, (e) => e.tag === "li" && !!e.props["data-step"]).map((e) => e.props["data-step"] + ":" + e.props["data-status"])).toEqual(["declare:done", "fetch:done", "assemble:running", "upload:pending", "restart:pending"]);
  expect(text(find(shown, (e) => e.tag === "li" && e.props["data-step"] === "assemble")[0])).toBe("Assemble a new version: running");
  await new Promise((r) => setTimeout(r, 1600));
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("a rebuild that failed names its step, and the retry is sent from the page; a version not running rolls back after a confirm", async () => {
  const failed = { rebuilds: true, runs: [runOf(2, "failed", { declare: "done", fetch: "done", assemble: "done", upload: "failed" }, { version: 2 })], versions: [version(1, {}), version(2, { backups: "0.2.0" })], current: 1 };
  const { page, sent, toasts, confirms } = await openPage({}, { mode: "filesystem" }, {}, {
    "/api/rebuilds": () => failed,
    "/api/rebuilds/retry": () => ({ message: "Retrying rebuild 2 from the upload step." }),
    "/api/rebuilds/rollback": () => ({ message: "Rolling back to version 2: the instance starts again onto it." }),
  });
  const shown = render(page);
  expect(text(find(shown, (e) => e.props.className === "rebuild-failed")[0])).toStartWith("It failed at the upload step.");
  expect(text(find(shown, (e) => e.tag === "li" && e.props["data-step"] === "upload")[0])).toContain("EACCES: permission denied");
  click(shown, "Retry from upload"); await settle();
  expect(posted(sent, "/api/rebuilds/retry")).toEqual([{}]);
  expect(toasts).toContain("Retrying rebuild 2 from the upload step.");
  expect(find(shown, (e) => e.tag === "tr" && !!e.props["data-version"]).map(text)).toEqual(["2backups 0.2.02026-09-13T12:00:00ZRoll back to 2", "1 (running)No plugins installed2026-09-13T11:00:00Z"]);
  click(shown, "Roll back to 2"); await settle();
  expect(confirms[0]).toStartWith("Roll the instance back to version 2?");
  expect(posted(sent, "/api/rebuilds/rollback")).toEqual([{ version: 2 }]);
});

test("a vanilla instance installs from the marketplace, reports an approved update and takes it, and removes a plugin once told what depends on it", async () => {
  const { page, sent, toasts, confirms } = await openPage({}, { mode: "filesystem" }, {}, {
    "/api/plugins/available": () => ({ available: [{ marketplace: "https://m.example", plugins: [{ name: "backups", title: "Backups", summary: "zips the data", latest: "0.2.0" }, { name: "mail", title: "Mail", summary: "sends mail", latest: "0.1.0" }] }] }),
    "/api/plugins/updates": () => ({ updates: [{ name: "backups", installed: "0.1.0", latest: "0.2.0", commit: "0123456789abcdef0123", marketplace: "https://m.example" }], installed: [{ name: "backups", version: "0.1.0", marketplace: "https://m.example" }] }),
    "/api/plugins/install": () => ({ message: "Installed mail 0.1.0 from https://m.example. A rebuild is queued." }),
    "/api/plugins/update": () => ({ message: "Updated backups 0.1.0 -> 0.2.0. A rebuild is queued." }),
    "/api/plugins/remove": (o) => ((o.body as { force?: boolean }).force ? { message: "Removed audit." } : Promise.reject(Object.assign(new Error("refused"), { status: 409, response: { message: 'Removing audit stops vault-report, which requires it. To go ahead, send this again with "force": true.', dependents: ["vault-report"] } }))),
  });
  const shown = render(page);
  expect(text(find(shown, (e) => e.tag === "li" && e.props["data-update"] === "backups")[0])).toBe("backups 0.1.0 has an approved update to 0.2.0 (commit 0123456789ab). The instance runs 0.1.0 until you take it. Update backups");
  expect(find(shown, (e) => e.tag === "tr" && !!e.props["data-available"]).map(text)).toEqual(["Backupszips the data0.2.0Update to 0.2.0", "Mailsends mail0.1.0Install"]);
  click(shown, "Install"); await settle();
  expect(posted(sent, "/api/plugins/install")).toEqual([{ name: "mail", marketplace: "https://m.example" }]);
  click(shown, "Update backups"); await settle();
  expect(posted(sent, "/api/plugins/update")).toEqual([{ name: "backups" }]);
  click(shown, "Remove"); await settle();
  expect(confirms).toEqual(["Removing audit stops vault-report, which requires it."]);
  expect(posted(sent, "/api/plugins/remove")).toEqual([{ name: "audit" }, { name: "audit", force: true }]);
  expect(toasts).toEqual(["Installed mail 0.1.0 from https://m.example. A rebuild is queued.", "Updated backups 0.1.0 -> 0.2.0. A rebuild is queued.", "Removed audit."]);
});
