// What GET /api/plugins answers, and why the plugins answer half of it themselves.
//
// One half is the graph the kernel resolved: the names, the providers, the tiers, what each plugin provides and
// requires, which core interface nothing provides, where each plugin came from. The other half is what a plugin
// knows about itself with these bindings — where mail goes, which locales are declared, whether the shop is on —
// and app.ts used to build it by calling the shipped modules' own functions. That made the swap cosmetic: an
// installed plugin shadows a shipped one by name at load, and the answer went on describing the module that was
// not running. So a plugin declares `info(env)` beside its manifest, and this assembles the answer from the
// plugins that actually loaded, by name. A name nothing loaded, or a plugin that says nothing about itself, is
// left out of the answer, exactly as an unloaded plugin was left out of it before.
//
// Two fields are not left out, because they are not a plugin's answer to give: `installer` is where this
// instance's plugins live and `mail` is where its mail goes, both of which the core knows on its own and both of
// which its own clients read into (`voidbase cloud plugins <instance> ls` prints `installer.mode`). A plugin
// loaded under either name still answers for it — that is the whole point of the swap — but when none does, the
// core answers, the way `payments` and `observability` are answered by their interface or by a stated "none".
//
// A plugin's `info()` runs inside this route, and on an instance that installed one, that is community code in
// the answer a superuser reads to see what is loaded. So each call is held at arm's length (`said` below): one
// that throws, or answers with something that is not an object, is reported as that one field's failure and the
// rest of the answer — the graph half included — still stands.
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

/**
 * One field of the answer, from code this module does not own. A field that fails is that field's failure and
 * nothing else's: the graph half and every other plugin still answer, and the failure is in the field where the
 * answer would have been, so a superuser reading the inventory sees which plugin could not describe itself.
 */
async function said(name: string, info: Info, env: Bindings): Promise<Record<string, unknown>> {
  try {
    const answer = await info(env);
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

export async function pluginsReport(kernel: Kernel, env: Bindings): Promise<Record<string, unknown>> {
  /** what the plugin loaded under this name says about itself, under that name; nothing when there is none to ask */
  const info = async (name: string): Promise<Record<string, unknown>> => {
    const plugin = infoOf(kernel, name);
    return plugin ? { [name]: await said(name, plugin, env) } : {};
  };
  /** a field the core answers for itself: the plugin loaded under the name wins, and the core answers without one */
  const core = async (name: string, own: Info): Promise<Record<string, unknown>> => ({ [name]: await said(name, infoOf(kernel, name) ?? own, env) });
  // commerce quotes through whoever provides tax@1 and shipping@1 and never learns which plugin that is, so its two
  // nested fields are the providers' own answers rather than the shipped flat-rate pair's. The key follows the
  // interface and not the answer: a provider with nothing to say is null rather than absent, so that replacing the
  // flat-rate pair — which the interfaces exist to allow — cannot quietly change the shape of the answer. Which
  // plugin it is is in `providers` above, where it is the same fact for every interface.
  const provider = async (iface: InterfaceName, field: string): Promise<Record<string, unknown>> => {
    const name = whatLoaded(kernel).providers[iface];
    if (!name) return {};
    const plugin = infoOf(kernel, name);
    return { [field]: plugin ? await said(name, plugin, env) : null };
  };
  const commerce = infoOf(kernel, "commerce");
  return {
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
    ...(commerce ? { commerce: { ...(await said("commerce", commerce, env)), ...(await provider("tax@1", "tax")), ...(await provider("shipping@1", "shipping")) } } : {}),
  };
}
