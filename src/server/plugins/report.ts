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
// answers for it — that is the whole point of the swap — but when none does, the core answers. The core's own
// installer answer lives in ../installer-info.ts rather than in the installer plugin, because this module is the
// core and may not import a plugin to answer for a plugin that is not running. `payments` and `observability` are
// answered through their interfaces, which is the older seam and the better one: an instance with no provider says
// `{via:"none"}` and `null` rather than leaving the field out.
//
// Every other loaded plugin that declares `info()` answers under its own name too, after the fields above, in load
// order: the docstring on `Plugin.info` is an offer to any plugin, not to seven of them, so a community plugin
// under a name of its own is asked like the rest. The exception is a plugin whose `info()` already answers
// somewhere else in this object — the `tax@1` and `shipping@1` providers, which answer inside `commerce` — and a
// plugin whose name is already a field of this answer, which is left out with a warning rather than allowed to
// overwrite it.
//
// A plugin's `info()` runs inside this route, and on an instance that installed one, that is community code in the
// answer a superuser reads to see what is loaded. So every call into a plugin is held at arm's length (`held`
// below): it is given a short while to answer, its answer is put through JSON before it is believed, and one that
// throws, that never settles, that answers with something which is not an object or that answers with something
// the route could not have sent (a cycle, a getter or a toJSON that throws) is reported as that one field's
// failure — the rest of the answer, the graph half included, still stands. That covers the two fields answered
// through an interface as well: a `payments@1` or `observability@1` provider is a plugin like any other, and on an
// instance that installed one it is the same community code, so `route(env)` and `report(env)` go through the same
// gate as an `info()` and only the core's default (`{via:"none"}`, `null`) is the core's own.
//
// Every one of those calls is started before any of them is awaited, so the timeout is the route's bound and not
// each plugin's share of it: twenty plugins that never answer hold this for about one timeout rather than twenty.
// The awaits below are sequential only to fix the key order, which is part of the answer: a default instance's
// JSON is byte-identical to the one this replaced (test/unit/plugin-seams.test.ts holds the snapshot), which is
// why the fields sit where the old ones sat.
import { logger } from "#platform/log";
import { installerInfo } from "../installer-info";
import type { Observability, Payments } from "../interfaces";
import { loadedPlugin, using, whatLoaded, type Kernel } from "../kernel";
import { mailRoute } from "../mail";
import type { Bindings } from "../types";
import type { InterfaceName } from "./manifest";

/** what this plugin says about itself, bound to it, or nothing when there is no plugin under that name to ask */
type Info = (env: Bindings) => object | Promise<object>;
/**
 * Reading `info` off the plugin object is already reading a plugin's code: on an instance that installed one it can
 * be a getter, and a getter that throws would take the whole report down here, before any guard was entered. So the
 * read is held like the call, and a plugin whose `info` cannot even be read fails its own field the way one whose
 * `info()` throws does, rather than the route failing for it.
 */
const infoOf = (kernel: Kernel, name: string): Info | undefined => {
  let declared: Info | undefined;
  try { declared = loadedPlugin(kernel, name)?.info; }
  catch (err) { return () => { throw err; }; }
  const info = declared;
  return info ? (env) => info(env) : undefined;
};

const shapeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v);

/** the fields this module answers by name, in the order they appear: a plugin under one of these is asked there */
const SPELLED_OUT = ["installer", "mail", "ai", "translations", "domains", "previews", "commerce"];
/**
 * How long a plugin gets to say what it is before the answer says it did not. A superuser is waiting on the route,
 * and this is what they wait: every call is started together, so it is the whole report's budget and not each
 * plugin's.
 */
const INFO_TIMEOUT_MS = 1000;

/** `work`, or a rejection once `ms` have passed: a plugin that never answers is a failed field, not a hung Worker */
function within<T>(name: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} did not say what it is within ${ms}ms`)), ms); });
  return Promise.race([work, late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * One call into code this module does not own, and the value it came back with, held. A field that fails is that
 * field's failure and nothing else's: the graph half and every other plugin still answer, and the failure is in the
 * field where the answer would have been, so a superuser reading the inventory sees which plugin could not describe
 * itself.
 *
 * Both halves of "answer" are held: the call, which may throw or never settle, and the value, which is this
 * module's only chance to find out whether the route can send it. `c.json()` serialises the whole answer at once,
 * so a value that JSON cannot take — a cycle, a throwing getter, a throwing toJSON — would take the entire route
 * down with a 500 long after this function returned. Putting each answer through JSON here is what keeps one
 * plugin's bad value inside one plugin's field, and it is the value that goes into the answer, so what this
 * returns is exactly what the route will send.
 */
async function held(name: string, call: () => unknown, ms: number): Promise<{ value: unknown } | { error: string }> {
  try {
    const answered = await within(name, (async () => call())(), ms);
    try { const wire = JSON.stringify(answered); return { value: wire === undefined ? undefined : JSON.parse(wire) }; }
    catch (err) { throw new Error(`${name} described itself with something that cannot be sent as JSON: ${err instanceof Error ? err.message : String(err)}`); }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("voidbase: a plugin could not describe itself; /api/plugins reports that field as failed and answers the rest", { plugin: name, error: message });
    return { error: message };
  }
}

/** a field of this answer is an object or it is an error: anything else a plugin came back with is the latter */
function shaped(name: string, answer: unknown): Record<string, unknown> {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    logger.warn("voidbase: a plugin described itself with something that is not an object; /api/plugins reports that field as failed", { plugin: name, answered: shapeOf(answer) });
    return { error: `${name} answered ${shapeOf(answer)} rather than an object` };
  }
  return answer as Record<string, unknown>;
}

/** one field of the answer, from the plugin loaded under `name`: its `info()`, held by its call and by its value */
async function said(name: string, info: Info, env: Bindings, ms: number): Promise<Record<string, unknown>> {
  const got = await held(name, () => info(env), ms);
  return "error" in got ? { error: got.error } : shaped(name, got.value);
}

export async function pluginsReport(kernel: Kernel, env: Bindings, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const ms = opts.timeoutMs ?? INFO_TIMEOUT_MS;
  const graph = whatLoaded(kernel);
  /**
   * The plugins whose info() answers under a key that is not their name, so that they are not asked twice. Filled
   * by `provider` below, which records the name before it awaits anything, so this set is complete by the time the
   * loop at the end reads it even though the answers it is waiting on are not.
   */
  const elsewhere = new Set<string>();
  /** what the plugin loaded under this name says about itself; nothing when there is no plugin under it to ask */
  const ask = (name: string): Promise<Record<string, unknown>> | undefined => {
    const info = infoOf(kernel, name);
    return info ? said(name, info, env, ms) : undefined;
  };
  /** a field the core answers for itself: the plugin loaded under the name wins, and the core answers without one */
  const ours = (name: string, own: Info): Promise<Record<string, unknown>> => said(name, infoOf(kernel, name) ?? own, env, ms);
  /**
   * A field answered through an interface rather than under a name: what is reported is the provider's, whatever
   * the plugin providing it is called, which is why these two did not need the swap. The provider is still a
   * plugin, and on an instance that installed one it is community code, so the call is held exactly as an `info()`
   * is. What is the core's here is only the default: with nothing providing the interface — and with a provider
   * that answers the interface's own "nothing here", which `payments@1.route()` spells `null` — the field says so
   * rather than vanishing, so that replacing a provider cannot change the shape of the answer.
   */
  const through = async <T>(iface: InterfaceName, none: unknown, call: (impl: T) => unknown): Promise<unknown> => {
    const name = graph.providers[iface] ?? iface;
    // the implementation is read inside the gate as well as called there: it is a plugin's own object, handed back
    // through cordis, and a property that throws on the way out would take the report down before the call was held.
    // With nothing providing the interface the call answers nothing, which is the core's default below.
    const got = await held(name, () => {
      const impl = using<T | undefined>(kernel, iface);
      return impl === undefined || impl === null ? undefined : call(impl);
    }, ms);
    if ("error" in got) return { error: got.error };
    return got.value === undefined || got.value === null ? none : shaped(name, got.value);
  };
  // commerce quotes through whoever provides tax@1 and shipping@1 and never learns which plugin that is, so its two
  // nested fields are the providers' own answers rather than the shipped flat-rate pair's. The key follows the
  // interface and not the answer: a provider with nothing to say is null rather than absent, so that replacing the
  // flat-rate pair — which the interfaces exist to allow — cannot quietly change the shape of the answer. Which
  // plugin it is is in `providers` above, where it is the same fact for every interface.
  const provider = async (iface: InterfaceName, field: string): Promise<Record<string, unknown>> => {
    const name = graph.providers[iface];
    if (!name) return {};
    elsewhere.add(name);
    const info = infoOf(kernel, name);
    return { [field]: info ? await said(name, info, env, ms) : null };
  };

  // Everything a plugin is asked starts here, before the first await below: each call is raced against its own
  // timeout, and every race overlaps every other, so the route waits about one timeout however many plugins never
  // answer rather than one timeout each. The awaits further down are sequential only to fix the key order.
  const commerceOwn = infoOf(kernel, "commerce");
  /** the fields this module answers by name, in the order they appear; the ones a plugin owns may be absent */
  const fields: [string, Promise<unknown> | undefined][] = [
    ["installer", ours("installer", (e) => installerInfo(e))],
    ["mail", ours("mail", (e) => mailRoute(e))],
    ["ai", ask("ai")],
    ["observability", through<Observability>("observability@1", null, (o) => o.report(env))],
    ["translations", ask("translations")],
    ["domains", ask("domains")],
    ["previews", ask("previews")],
    ["payments", through<Payments>("payments@1", { via: "none" }, (p) => p.route(env))],
    // commerce is its own answer with the two providers' answers inside it; all three start here like the rest
    ["commerce", commerceOwn ? (async () => {
      const own = said("commerce", commerceOwn, env, ms);
      const tax = provider("tax@1", "tax");
      const shipping = provider("shipping@1", "shipping");
      return { ...(await own), ...(await tax), ...(await shipping) };
    })() : undefined],
  ];

  // and every other plugin that declares info(), under its own name, in load order: the offer is to any plugin,
  // which is what the fields above were only seven of. Appended, so the answer above keeps the key order it had.
  //
  // A plugin whose name is already a field of this answer is left out with a warning rather than allowed to
  // overwrite it: the graph half's own seven keys, `installer` and `mail`, and `observability` and `payments`,
  // which are a provider's answer under a name the provider did not choose. `keys` is the answer's own keys, known
  // before any of the answers are, and it is a set rather than `name in answer` because `in` walks the prototype
  // chain: `constructor` passes the manifest's name rule (lowercase letters, digits and dashes), and `in` is true
  // of it however little the answer holds, so a plugin of that name was dropped with a warning about a field this
  // answer does not have.
  const keys = new Set([...Object.keys(graph), ...fields.filter(([, value]) => value).map(([key]) => key)]);
  const rest: [string, Promise<Record<string, unknown>>][] = [];
  for (const name of graph.names) {
    if (SPELLED_OUT.includes(name) || elsewhere.has(name)) continue;
    const info = infoOf(kernel, name);
    if (!info) continue;
    if (keys.has(name)) {
      logger.warn("voidbase: a plugin's name is a field /api/plugins answers for itself, so what it says about itself is left out of the answer", { plugin: name });
      continue;
    }
    keys.add(name);
    rest.push([name, said(name, info, env, ms)]);
  }

  // The graph half is plugin data too: a manifest is an installed bundle's own file, and a field it chose can be a
  // value JSON cannot take. c.json() serialises the whole answer at once, so each part goes through the same round
  // trip a plugin's answer does, and a part that cannot make it says so in its own place rather than in a 500.
  const answer: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(graph)) {
    try {
      const wire = JSON.stringify(value);
      answer[key] = wire === undefined ? null : JSON.parse(wire);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("voidbase: a plugin's manifest cannot be sent as JSON; /api/plugins reports that part as failed and answers the rest", { part: key, error: message });
      answer[key] = { error: message };
    }
  }
  for (const [key, value] of fields) if (value) answer[key] = await value;
  for (const [name, value] of rest) answer[name] = await value;
  return answer;
}
