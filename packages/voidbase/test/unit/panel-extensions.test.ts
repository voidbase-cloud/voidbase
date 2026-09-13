// The admin panel's Plugins page (src/panel/extensions.ts), run the way the panel runs its extensions file: against an
// `app` with a router, a store and the SDK, and `t` and `store` as globals. What is checked is what the page does with
// the instance's answers: the header link, the plugin list with where each came from, a plane editable on vanilla and
// read only when the project declares it, and a save that sends only what changed.
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

async function openPage(planes: Record<string, unknown>) {
  const routes: Record<string, () => unknown> = {}; const sent: { path: string; options: Record<string, unknown> }[] = []; const toasts: string[] = [];
  const app = {
    routes: { superuserOnly: (path: string, handler: () => unknown) => { routes[path] = handler; } },
    store: { headerLinks: [{ href: "#/collections" }, { href: "#/logs" }, { href: "#/settings" }], title: "" },
    components: {}, checkApiError: (err: unknown) => { throw err; },
    toasts: { success: (m: string) => toasts.push(m), info: (m: string) => toasts.push(m) },
    pb: { send: async (path: string, options: Record<string, unknown>) => {
      sent.push({ path, options });
      if (path === "/api/plugins") return { plugins: [{ name: "hardening", tier: "core", source: "voidbase", provides: ["hardening@1"] }, { name: "audit", tier: "community", source: "repository", provides: [] }] };
      if (path === "/api/plugins/config") return planes;
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
  expect(rows.map(text)).toEqual(["hardeningcoreShips with voidbasehardening@1", "auditcommunityDeclared in the repository"]);
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
