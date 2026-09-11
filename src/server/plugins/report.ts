// What GET /api/plugins answers, and why the plugins answer half of it themselves.
//
// One half is the graph the kernel resolved: the names, the providers, the tiers, what each plugin provides and
// requires, which core interface nothing provides, where each plugin came from. The other half is what a plugin
// knows about itself with these bindings — where mail goes, which locales are declared, whether the shop is on —
// and app.ts used to build it by calling the shipped modules' own functions. That made the swap cosmetic: an
// installed plugin shadows a shipped one by name at load, and the answer went on describing the module that was
// not running. So a plugin declares `info(env)` beside its manifest, and this assembles the answer from the
// plugins that actually loaded, by name.
//
// That is a change to what an instance reports about itself, and the first one this route has made. Every
// instance through 0.9.0-beta.48 answered every one of these fields whatever was loaded; from here on a
// per-plugin field is in the answer only while a plugin answers for it. `ai`, `translations`,
// `domains`, `previews` and `commerce` are each a loaded plugin's own answer, so an instance that turned one off in
// voidbase.lock, or installed a plugin over its name that says nothing about itself, has no such field — where the
// old expression called the shipped module whatever was running and answered anyway. A reader of this answer takes
// a missing field as "no plugin here says", not as "off": what is loaded is in `names` and `origins`, which is the
// graph half and is unchanged.
//
// Four fields do not depend on a plugin. `installer` is where this instance's plugins live and `mail` is where its
// mail goes: both are facts about the instance rather than about a plugin, our own clients read into them
// (`voidbase cloud plugins <instance> ls` prints `installer.mode`), and so a plugin loaded under either name
// answers for it — that is the whole point of the swap — but when none does, the core answers. `payments` and
// `observability` are answered through their interfaces, which is the older seam and the better one: an instance
// with no provider says `{via:"none"}` and `null` rather than leaving the field out.
//
// Every other loaded plugin that declares `info()` answers under its own name too, after the fields above, in load
// order: the docstring on `Plugin.info` is an offer to any plugin, not to seven of them, so a community plugin
// under a name of its own is asked like the rest. The exception is a plugin whose `info()` already answers
// somewhere else in this object — the `tax@1` and `shipping@1` providers, which answer inside `commerce` — and a
// plugin whose name is one of the graph half's own keys, which is left out with a warning rather than allowed to
// overwrite it.
//
// A plugin's `info()` runs inside this route, and on an instance that installed one, that is community code in the
// answer a superuser reads to see what is loaded. So each call is held at arm's length (`said` below): it is given
// a short while to answer, its answer is put through JSON before it is believed, and one that throws, that never
// settles, that answers with something which is not an object or that answers with something the route could not
// have sent (a cycle, a getter or a toJSON that throws) is reported as that one field's failure — the rest of the
// answer, the graph half included, still stands.
//
// The key order is part of the answer: a default instance's JSON is byte-identical to the one this replaced
// (test/unit/plugin-seams.test.ts holds the snapshot), which is why the spreads sit where the old fields sat.
import { logger } from "#platform/log";
import type { Observability, Payments } from "../interfaces";
import { loadedPlugin, using, whatLoaded, type Kernel } from "../kernel";
import { mailRoute } from "../mail";
import type { Bindings } from "../types";
import { installerInfo } from "./installer";
import type { InterfaceName } from "./manifest";

/** what this plugin says about itself, bound to it, or nothing when there is no plugin under that name to ask */
type Info = (env: Bindings) => object | Promise<object>;
const infoOf = (kernel: Kernel, name: string): Info | undefined => {
  const plugin = loadedPlugin(kernel, name);
  return plugin?.info ? (env) => plugin.info!(env) : undefined;
};

const shapeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v);

/** the fields this module answers by name, in the order they appear: a plugin under one of these is asked there */
const SPELLED_OUT = ["installer", "mail", "ai", "translations", "domains", "previews", "commerce"];
/** the graph half's own keys: a plugin named like one of them is not given the chance to overwrite it */
const GRAPH_KEYS = new Set(["names", "providers", "tiers", "plugins", "missingCore", "origins", "disabled"]);
/** how long a plugin gets to say what it is before the answer says it did not. A superuser is waiting on the route */
const INFO_TIMEOUT_MS = 1000;

/** `work`, or a rejection once `ms` have passed: a plugin that never answers is a failed field, not a hung Worker */
function within<T>(name: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} did not say what it is within ${ms}ms`)), ms); });
  return Promise.race([work, late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * One field of the answer, from code this module does not own. A field that fails is that field's failure and
 * nothing else's: the graph half and every other plugin still answer, and the failure is in the field where the
 * answer would have been, so a superuser reading the inventory sees which plugin could not describe itself.
 *
 * Both halves of "answer" are held: the call, which may throw or never settle, and the value, which is this
 * module's only chance to find out whether the route can send it. `c.json()` serialises the whole answer at once,
 * so a value that JSON cannot take — a cycle, a throwing getter, a throwing toJSON — would take the entire route
 * down with a 500 long after this function returned. Putting each answer through JSON here is what keeps one
 * plugin's bad value inside one plugin's field, and it is the value that goes into the answer, so what this
 * returns is exactly what the route will send.
 */
async function said(name: string, info: Info, env: Bindings, ms: number): Promise<Record<string, unknown>> {
  try {
    const answered = await within(name, (async () => info(env))(), ms);
    let answer: unknown;
    try { const wire = JSON.stringify(answered); answer = wire === undefined ? undefined : JSON.parse(wire); }
    catch (err) { throw new Error(`${name} described itself with something that cannot be sent as JSON: ${err instanceof Error ? err.message : String(err)}`); }
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      logger.warn("voidbase: a plugin described itself with something that is not an object; /api/plugins reports that field as failed", { plugin: name, answered: shapeOf(answer) });
      return { error: `${name} answered ${shapeOf(answer)} rather than an object` };
    }
    return answer as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("voidbase: a plugin could not describe itself; /api/plugins reports that field as failed and answers the rest", { plugin: name, error: message });
    return { error: message };
  }
}

export async function pluginsReport(kernel: Kernel, env: Bindings, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const ms = opts.timeoutMs ?? INFO_TIMEOUT_MS;
  /** the plugins whose info() answers under a key that is not their name, so that they are not asked twice */
  const elsewhere = new Set<string>();
  /** what the plugin loaded under this name says about itself, under that name; nothing when there is none to ask */
  const info = async (name: string): Promise<Record<string, unknown>> => {
    const plugin = infoOf(kernel, name);
    return plugin ? { [name]: await said(name, plugin, env, ms) } : {};
  };
  /** a field the core answers for itself: the plugin loaded under the name wins, and the core answers without one */
  const core = async (name: string, own: Info): Promise<Record<string, unknown>> => ({ [name]: await said(name, infoOf(kernel, name) ?? own, env, ms) });
  // commerce quotes through whoever provides tax@1 and shipping@1 and never learns which plugin that is, so its two
  // nested fields are the providers' own answers rather than the shipped flat-rate pair's. The key follows the
  // interface and not the answer: a provider with nothing to say is null rather than absent, so that replacing the
  // flat-rate pair — which the interfaces exist to allow — cannot quietly change the shape of the answer. Which
  // plugin it is is in `providers` above, where it is the same fact for every interface.
  const provider = async (iface: InterfaceName, field: string): Promise<Record<string, unknown>> => {
    const name = whatLoaded(kernel).providers[iface];
    if (!name) return {};
    elsewhere.add(name);
    const plugin = infoOf(kernel, name);
    return { [field]: plugin ? await said(name, plugin, env, ms) : null };
  };
  const commerce = infoOf(kernel, "commerce");
  const answer: Record<string, unknown> = {
    ...whatLoaded(kernel),
    ...(await core("installer", (e) => installerInfo(e))),
    ...(await core("mail", (e) => mailRoute(e))),
    ...(await info("ai")),
    // observability and payments answer through their interfaces, which is the older seam and the better one: what
    // is reported is the provider's, whatever the plugin providing it is called, so there is nothing to fix here
    observability: (await using<Observability | undefined>(kernel, "observability@1")?.report(env)) ?? null,
    ...(await info("translations")),
    ...(await info("domains")),
    ...(await info("previews")),
    payments: using<Payments | undefined>(kernel, "payments@1")?.route(env) ?? { via: "none" },
    ...(commerce ? { commerce: { ...(await said("commerce", commerce, env, ms)), ...(await provider("tax@1", "tax")), ...(await provider("shipping@1", "shipping")) } } : {}),
  };
  // and every other plugin that declares info(), under its own name, in load order: the offer is to any plugin,
  // which is what the fields above were only seven of. Appended, so the answer above keeps the key order it had.
  for (const name of whatLoaded(kernel).names) {
    if (SPELLED_OUT.includes(name) || elsewhere.has(name)) continue;
    const plugin = infoOf(kernel, name);
    if (!plugin) continue;
    if (GRAPH_KEYS.has(name) || name in answer) {
      logger.warn("voidbase: a plugin's name is a field /api/plugins answers for itself, so what it says about itself is left out of the answer", { plugin: name });
      continue;
    }
    answer[name] = await said(name, plugin, env, ms);
  }
  return answer;
}
