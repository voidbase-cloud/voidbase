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

async function openPage(planes: Record<string, unknown>, installer: Record<string, unknown> = { mode: "filesystem" }) {
  const routes: Record<string, () => unknown> = {}; const sent: { path: string; options: Record<string, unknown> }[] = []; const toasts: string[] = [];
  const app = {
    routes: { superuserOnly: (path: string, handler: () => unknown) => { routes[path] = handler; } },
    store: { headerLinks: [{ href: "#/collections" }, { href: "#/logs" }, { href: "#/settings" }], title: "" },
    components: {}, checkApiError: (err: unknown) => { throw err; },
    toasts: { success: (m: string) => toasts.push(m), info: (m: string) => toasts.push(m) },
    pb: { send: async (path: string, options: Record<string, unknown>) => {
      sent.push({ path, options });
      if (path === "/api/plugins") {
        const source = installer.mode === "filesystem" ? "instance" : "repository";
        return { installer, plugins: [{ name: "hardening", tier: "core", source: "voidbase", provides: ["hardening@1"] }, { name: "audit", tier: "community", source, provides: [] }], files: { pb_hooks: source, pb_migrations: source, pb_public: source } };
      }
      // a fresh answer on every call, the way a response is
      if (path === "/api/plugins/config") return structuredClone(planes);
      return { message: "referrer_policy took effect." };
    } },
  };
  new Function("app", "t", "store", PANEL_EXTENSIONS)(app, t, (o: object) => o);
  const page = routes["#/plugins"]!();
  await new Promise((r) => setTimeout(r, 0));
  return { app, page, sent, toasts };
}

const hardening = { editable: true, fields: { referrer_policy: { type: "string", applies: "runtime", knob: "VOIDBASE_REFERRER_POLICY", value: "", source: "default" } } };
const observability = { editable: false, fields: { sample_rate: { type: "number", applies: "rebuild", knob: "VOIDBASE_OBSERVABILITY_SAMPLE", value: 1, source: "project", pending: 0.5 } } };

test("the panel gets a Plugins page listing what loaded and where each came from", async () => {
  const { app, page } = await openPage({ hardening, observability });
  expect(app.store.headerLinks.map((l) => l.href)).toEqual(["#/collections", "#/logs", "#/plugins", "#/settings"]);
  const shown = render(page);
  const rows = find(shown, (e) => e.tag === "tr" && !!e.props["data-plugin"]);
  expect(rows.map(text)).toEqual(["hardeningcoreShips with voidbaseNo: it ships with voidbasehardening@1", "auditcommunityInstalled on this instanceYes"]);
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

test("saving sends only the fields that changed and says what the instance answered", async () => {
  const { page, sent, toasts } = await openPage({ hardening });
  const shown = render(page);
  const input = find(shown, (e) => e.tag === "input")[0]!;
  (input.props.oninput as (e: unknown) => void)({ target: { value: "no-referrer" } });
  (find(shown, (e) => e.tag === "button")[0]!.props.onclick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.find((s) => s.path === "/api/plugins/config/hardening")?.options).toEqual({ method: "PATCH", body: { referrer_policy: "no-referrer" } });
  expect(toasts).toEqual(["referrer_policy took effect."]);
});
