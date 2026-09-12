// The three seams between the core and a plugin that packaging would otherwise bake a bug into.
//
// Nothing here is about what a plugin does; it is about what the core hands it and what it hands back. A plugin
// reaches the record context through a slot rather than by importing the app, because a package cannot import the
// package that loads it. A plugin says what it is set to through its own info(), because the answer has to come
// from whatever loaded under the name and not from the module it replaced — except where the answer is the core's
// own (installer, mail), which no plugin can take out of it, and held at arm's length, because on an instance that
// installed a plugin that is community code running inside a superuser's route. And the realtime slot is guarded
// like the others, because `using` answers undefined when nothing provides an interface and this one is read on
// every request.
//
// The snapshot in test/fixtures/plugins-answer.json is the answer GET /api/plugins gave before the plugins
// described themselves. It pins one construction and one set of bindings: app.ts's own twenty plugins in app.ts's
// order, its own installer — `installer(VERSION, undefined, ...)`, so the filesystem is the platform's and the
// field reads {"mode":"filesystem"}, not the {"mode":"fixed"} that a null filesystem answers — and the `env`
// below, whose database throws. The bytes are JSON.stringify of app.ts's expression at c14edb2, which `oldAnswer`
// rebuilds here from the same still-exported helpers, so the file is checked against it rather than trusted.
// Regenerate it only when the answer is meant to change, and say in the changelog what moved: a diff here is a
// change to what every instance reports about itself.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Hono } from "hono";
import { authRefresh } from "../../src/server/auth";
import type { Collection } from "../../src/server/collections/model";
import { installerInfo } from "../../src/server/installer-info";
import type { Mail as MailInterface, Observability, Payments, Realtime, Tax } from "../../src/server/interfaces";
import { createKernel, load, serve, using, whatLoaded, type Kernel } from "../../src/server/kernel";
import { mailRoute } from "../../src/server/mail";
import { provideRecordContext, recordContextBuilder, restoreRecordContext, type RecordContextBuilder } from "../../src/server/record-slot";
import { realtimeOf, realtimeOff } from "../../src/server/realtime-slot";
import type { RecordContext } from "../../src/server/records/service";
import { ai, aiRoute } from "../../src/server/plugins/ai";
import { auth } from "../../src/server/plugins/auth";
import { backups } from "../../src/server/plugins/backups";
import { commerce, commerceInfo } from "../../src/server/plugins/commerce";
import { domains, domainsInfo } from "../../src/server/plugins/domains";
import { hardening } from "../../src/server/plugins/hardening";
import { installer } from "../../src/server/plugins/installer";
import { lemonsqueezy } from "../../src/server/plugins/lemonsqueezy";
import { mail } from "../../src/server/plugins/mail";
import type { Plugin } from "../../src/server/plugins/manifest";
import { mcp } from "../../src/server/plugins/mcp";
import { observability } from "../../src/server/plugins/observability";
import { openapi } from "../../src/server/plugins/openapi";
import { polar } from "../../src/server/plugins/polar";
import { previews, previewsReport } from "../../src/server/plugins/previews";
import { realtime } from "../../src/server/plugins/realtime";
import { pluginsReport } from "../../src/server/plugins/report";
import { CORE } from "../../src/server/plugins/resolve";
import { seo, seoWith } from "../../src/server/plugins/seo";
import { shippingFlat, shippingFlatInfo } from "../../src/server/plugins/shipping-flat";
import { stripe } from "../../src/server/plugins/stripe";
import { taxFlat, taxFlatInfo } from "../../src/server/plugins/tax-flat";
import { translations, translationsInfo } from "../../src/server/plugins/translations";
import { presenceEnabled } from "../../src/server/realtime/presence";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";
import { VERSION } from "../../src/server/version";

/** a request's bindings without a database: every field of the answer that needs one already says so for itself */
const env = { DB: new Proxy({}, { get() { throw new Error("no database here"); } }), STORAGE: {} } as unknown as Bindings;

/**
 * The twenty plugins a default instance loads, in app.ts's order and built the way app.ts builds them: the
 * installer with no filesystem of its own, so it takes the platform's, which is what a Bun instance runs with and
 * what the snapshot pins.
 */
const shipped = (kernel: Kernel): Plugin[] => [
  auth, observability, realtime, hardening, backups, installer(VERSION, undefined, () => whatLoaded(kernel).plugins),
  openapi, mcp, seo, mail, ai, translations, stripe, polar, lemonsqueezy, taxFlat, shippingFlat, commerce, previews, domains,
];

/** a default instance, minus the names an installed plugin shadows, plus what it installed: app.ts's own filter */
async function instance(extra: Plugin[] = [], shadowed: string[] = []): Promise<Kernel> {
  const kernel = createKernel(new Hono<AppEnv>());
  await load(kernel, [...shipped(kernel).filter((p) => !shadowed.includes(p.manifest.name)), ...extra], VERSION);
  return kernel;
}

/** GET /api/plugins as app.ts built it at c14edb2, from the same modules' still-exported helpers */
async function oldAnswer(kernel: Kernel): Promise<Record<string, unknown>> {
  return { ...whatLoaded(kernel), installer: installerInfo(env), mail: await mailRoute(env), ai: await aiRoute(env), observability: (await using<Observability | undefined>(kernel, "observability@1")?.report(env)) ?? null, translations: translationsInfo(env), domains: domainsInfo(env), previews: await previewsReport(env), payments: using<Payments | undefined>(kernel, "payments@1")?.route(env) ?? { via: "none" }, commerce: { ...commerceInfo(env), tax: taxFlatInfo(env), shipping: shippingFlatInfo(env) } };
}

afterAll(() => { commerce.stopWatchingPayments(); });

/** the route as app.ts mounts it: c.json() serialises the whole answer at once, which is where a bad value lands */
async function route(kernel: Kernel, opts: { timeoutMs?: number } = {}): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => c.json({ crashed: err instanceof Error ? err.message : String(err) }, 500));
  app.get("/api/plugins", async (c) => c.json(await pluginsReport(kernel, c.env, opts)));
  return app.request("http://shop.example/api/plugins", {}, env as unknown as Bindings);
}
/** a failed field is logged, and a test that expects one says so rather than printing it */
const quiet = () => spyOn(console, "error").mockImplementation(() => {});

// --- the record context a plugin needs ----------------------------------------------------------------------------
describe("a plugin asks the core for the request's record context", () => {
  const source = (file: string) => readFileSync(resolvePath(import.meta.dir, "../../src/server", file), "utf8");
  // The slot is a module global and bun test runs every file in one process, so the stubs below are borrowed and
  // given back: whatever was in the slot when this file started goes back into it, which is app.ts's own builder
  // in any run where something imported app.ts first and nothing at all in a run where nothing did. Emptying it
  // instead — what this did — took app.ts's builder out of the process and left the next file with nothing, and
  // only the order bun walks test/unit in decided whether that was noticed
  // (test/unit/plugin-slot-restored.test.ts is the file that checks no stub is left behind).
  let outside: RecordContextBuilder | undefined;
  beforeAll(() => { outside = recordContextBuilder(); });
  afterAll(() => { restoreRecordContext(outside); });

  test("the slot is a borrow: filling it answers what was there, and that is what goes back", () => {
    const theirs: RecordContextBuilder = async () => ({ theirs: true }) as unknown as RecordContext;
    const before = provideRecordContext(theirs); // stands in for app.ts, which fills the slot at module scope
    const mine: RecordContextBuilder = async () => ({ mine: true }) as unknown as RecordContext;
    expect(provideRecordContext(mine)).toBe(theirs); // what a borrower is handed: exactly what it took
    expect(recordContextBuilder()).toBe(mine);
    restoreRecordContext(theirs); // and what it gives back, rather than emptying the slot on top of theirs
    expect(recordContextBuilder()).toBe(theirs);
    restoreRecordContext(before);
  });

  test("nothing the auth plugin mounts imports the app to get one, which a package cannot do to the package that loads it", () => {
    // plugins/auth.ts mounts three modules: its own routes, the core's auth routes (auth.ts) and the passkey ones
    // (webauthn.ts). hooks/index.ts is left as it is, being the application's own use of its own module.
    //
    // seo is no longer one of them: since 7.7 it is @voidbase-cloud/plugin-seo, and a package has no `../app` to
    // import even if it wanted one. The property is the same and is read where the code now is -- the slot is how a
    // plugin gets the request's record context -- which is why the file moved in this list rather than out of it.
    const files: [string, string][] = [
      ["plugins/auth.ts", source("plugins/auth.ts")],
      ["auth.ts", source("auth.ts")],
      ["webauthn.ts", source("webauthn.ts")],
      ["@voidbase-cloud/plugin-seo", readFileSync(resolvePath(import.meta.dir, "../../../plugin-seo/src/index.ts"), "utf8")],
    ];
    for (const [name, text] of files) {
      expect(text, name).not.toContain('import("./app")');
      expect(text, name).not.toContain('import("../app")');
      expect(text, name).toContain('record-slot"');
    }
  });

  test("seo's lookup of the record behind a page goes through the slot, once per request", async () => {
    const posts = {
      id: "c_posts", name: "posts", type: "base", system: false, listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null,
      indexes: [], options: {}, created: "", updated: "", fields: [{ id: "f_slug", name: "slug", type: "text" }],
    } as unknown as Collection;
    const asked: string[] = [];
    provideRecordContext((c) => { asked.push(c.req.path); throw new Error("the slot was asked"); });

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", null); await next(); });
    app.onError((err, c) => c.json({ message: err instanceof Error ? err.message : String(err) }, 500));
    const kernel = createKernel(app);
    // every part of the source but `record`, which is the one that needs a context and is the one under test
    await load(kernel, [auth, observability, seoWith({ collections: async () => [posts], appName: async () => "Shop" })], VERSION);

    const call = () => app.request("http://shop.example/api/seo/meta?path=/blog/hello", {}, { VOIDBASE_SITEMAP: "posts:/blog/{slug}" } as unknown as Bindings);
    expect(await (await call()).json()).toEqual({ message: "the slot was asked" });
    expect(asked).toEqual(["/api/seo/meta"]);
    // built per request, never held: the second request builds its own
    await call();
    expect(asked).toHaveLength(2);
  });

  test("and so do the core's auth routes, which that plugin mounts: auth-refresh builds one per request", async () => {
    const users = { id: "c_users", name: "users", type: "auth" } as unknown as Collection;
    const signedIn = { collection: users, row: { id: "u1" } } as unknown as AuthRecord;
    const asked: string[] = [];
    provideRecordContext((c) => { asked.push(c.req.path); throw new Error("the slot was asked"); });

    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.json({ message: err instanceof Error ? err.message : String(err) }, 500));
    app.post("/api/collections/:collection/auth-refresh", async (c) => { c.set("auth", signedIn); return authRefresh(c, users); });

    const r = await app.request("http://shop.example/api/collections/users/auth-refresh", { method: "POST" }, {} as unknown as Bindings);
    expect(await r.json()).toEqual({ message: "the slot was asked" });
    expect(asked).toEqual(["/api/collections/users/auth-refresh"]);
  });
});

// --- what a plugin says about itself -------------------------------------------------------------------------------
describe("/api/plugins is what the plugins that loaded say about themselves", () => {
  const snapshot = readFileSync(resolvePath(import.meta.dir, "../fixtures/plugins-answer.json"), "utf8").trim();

  test("a default instance answers byte for byte what it answered before, key order and all", async () => {
    expect(JSON.stringify(await pluginsReport(await instance(), env))).toBe(snapshot);
  });

  test("and the snapshot is that answer: app.ts's own expression, over the same plugins and bindings", async () => {
    expect(JSON.stringify(await oldAnswer(await instance()))).toBe(snapshot);
    // the field a snapshot of some other construction gets wrong: this one is built with the platform's filesystem
    expect((JSON.parse(snapshot) as { installer: unknown }).installer).toEqual(installerInfo(env));
  });

  test("a plugin installed over a shipped name answers for it: the swap is no longer cosmetic", async () => {
    const theirs: Plugin = {
      manifest: { name: "domains", version: "2.0.0", tier: "community", voidbase: "*" },
      info: () => ({ hostnames: ["shop.example"], canonical: "shop.example" }),
    };
    const answer = await pluginsReport(await instance([theirs], ["domains"]), env);
    expect(answer.domains).toEqual({ hostnames: ["shop.example"], canonical: "shop.example" });
    expect(answer.origins).toMatchObject({ domains: "shipped" }); // the graph half is unchanged by the swap
  });

  test("a name with no info() is left out, whether nothing loaded it or what loaded says nothing", async () => {
    expect("previews" in (await pluginsReport(await instance([], ["previews"]), env))).toBe(false);
    const quiet: Plugin = { manifest: { name: "previews", version: "2.0.0", tier: "community", voidbase: "*" } };
    expect("previews" in (await pluginsReport(await instance([quiet], ["previews"]), env))).toBe(false);
  });

  test("installer and mail are the core's own answers, which no plugin can take out of the answer", async () => {
    const own = { installer: installerInfo(env), mail: await mailRoute(env) };
    // turned off in voidbase.lock: nothing loads under either name, and both are still what this instance is
    expect(await pluginsReport(await instance([], ["installer", "mail"]), env)).toMatchObject(own);
    // or shadowed by a plugin that says nothing about itself, which is the swap the rest of this describe is about
    const quiet: Plugin[] = [
      { manifest: { name: "installer", version: "2.0.0", tier: "community", voidbase: "*" } },
      {
        manifest: { name: "mail", version: "2.0.0", tier: "community", voidbase: "*", provides: ["mail@1"] },
        apply: (ctx) => { serve<MailInterface>(ctx, "mail@1", { carrier: () => null, refuses: () => null, send: async () => {} }); },
      },
    ];
    expect(await pluginsReport(await instance(quiet, ["installer", "mail"]), env)).toMatchObject(own);
    // and a plugin that does answer still wins: the core answers for the name only while nothing else does
    const theirs: Plugin = { manifest: { name: "installer", version: "2.0.0", tier: "community", voidbase: "*" }, info: () => ({ mode: "theirs" }) };
    expect((await pluginsReport(await instance([theirs], ["installer"]), env)).installer).toEqual({ mode: "theirs" });
  });

  test("a plugin that cannot describe itself fails that one field and nothing else", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const boom: Plugin = { manifest: { name: "domains", version: "2.0.0", tier: "community", voidbase: "*" }, info: () => { throw new Error("this plugin's info blew up"); } };
    const answer = await pluginsReport(await instance([boom], ["domains"]), env);
    expect(answer.domains).toEqual({ error: "this plugin's info blew up" });
    // the graph half and every other plugin still answer, which is what the superuser opened the inventory for
    expect(answer.names).toContain("domains");
    expect(answer.installer).toEqual(installerInfo(env));
    expect(answer.previews).toEqual(await previewsReport(env));
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  test("and an answer that is not an object is the same failure: a field of the answer is an object or it is an error", async () => {
    const logged = spyOn(console, "warn").mockImplementation(() => {});
    const said = (name: string, answer: unknown): Plugin => ({ manifest: { name, version: "2.0.0", tier: "community", voidbase: "*" }, info: () => answer as object });
    const answer = await pluginsReport(await instance([said("domains", null), said("previews", "filesystem")], ["domains", "previews"]), env);
    expect(answer.domains).toEqual({ error: "domains answered null rather than an object" });
    expect(answer.previews).toEqual({ error: "previews answered string rather than an object" });
    expect(answer.mail).toEqual(await mailRoute(env));
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  test("commerce's tax and shipping are whoever provides the interfaces, not the shipped pair by name", async () => {
    const vat: Plugin = {
      manifest: { name: "tax-vat", version: "1.0.0", tier: "community", voidbase: "*", provides: ["tax@1"] },
      info: () => ({ rate: 20 }),
      apply: (ctx) => { serve<Tax>(ctx, "tax@1", { quote: async () => ({ lines: [], total: 0 }) }); },
    };
    const answer = await pluginsReport(await instance([vat], ["tax-flat"]), env);
    expect(answer.commerce).toEqual({ on: false, currency: "usd", tax: { rate: 20 }, shipping: { flat: 0, freeOver: 0 } });
  });

  test("and the two keys follow the interface: a provider with nothing to say is null, not a field that vanished", async () => {
    const quiet: Plugin = {
      manifest: { name: "tax-vat", version: "1.0.0", tier: "community", voidbase: "*", provides: ["tax@1"] },
      apply: (ctx) => { serve<Tax>(ctx, "tax@1", { quote: async () => ({ lines: [], total: 0 }) }); },
    };
    const answer = await pluginsReport(await instance([quiet], ["tax-flat"]), env);
    expect(answer.commerce).toEqual({ on: false, currency: "usd", tax: null, shipping: { flat: 0, freeOver: 0 } });
  });

  test("payments and observability still answer through their interfaces, untouched", async () => {
    const answer = await pluginsReport(await instance(), env);
    expect(answer.payments).toEqual({ via: "none" }); // stripe provides payments@1 and has no key in these bindings
    expect(answer.observability).toEqual({ via: "request-log", sampling: 1, logs: false });
    // and an instance with no provider for either says so where it always did, rather than leaving it out
    expect(await pluginsReport(await instance([], ["observability"]), env)).toMatchObject({ observability: null, payments: { via: "none" } });
  });
});

// --- which fields depend on a plugin, and which do not ------------------------------------------------------------
describe("a field is in the answer only while a plugin answers for it", () => {
  /** a plugin under a shipped name that says nothing about itself, with the manifest that name needs to load */
  const quiet = (name: string): Plugin => ({
    manifest: {
      name, version: "2.0.0", tier: "community", voidbase: "*",
      ...(name === "mail" ? { provides: ["mail@1" as const] } : {}),
    },
    ...(name === "mail" ? { apply: (ctx: Kernel) => { serve<MailInterface>(ctx, "mail@1", { carrier: () => null, refuses: () => null, send: async () => {} }); } } : {}),
  });
  /** the same, answering for itself */
  const loud = (name: string): Plugin => ({ ...quiet(name), info: () => ({ theirs: name }) });

  // This is the change this branch makes to what every instance through 0.9.0-beta.48 reported about itself, and it is pinned here name
  // by name so that it cannot drift back by accident: the core does not import a plugin module to answer for a
  // plugin that is not running, which is the whole of why the answer is assembled from what loaded.
  for (const name of ["ai", "translations", "domains", "previews", "commerce"]) {
    test(`${name} is absent when it is turned off in voidbase.lock, and absent when what shadows it says nothing`, async () => {
      expect(name in (await pluginsReport(await instance([], [name]), env))).toBe(false);
      expect(name in (await pluginsReport(await instance([quiet(name)], [name]), env))).toBe(false);
    });

    test(`${name} is the answer of whatever loaded under the name, when that plugin answers`, async () => {
      const answer = await pluginsReport(await instance([loud(name)], [name]), env);
      // commerce keeps its two nested keys, which follow the tax@1 and shipping@1 interfaces rather than the name
      expect(answer[name]).toEqual(name === "commerce" ? { theirs: name, tax: { rate: 0 }, shipping: { flat: 0, freeOver: 0 } } : { theirs: name });
      expect(answer.names).toContain(name); // and the graph half says it is loaded either way
    });
  }

  test("this is the change: the expression this replaced answered all five whatever was loaded", async () => {
    for (const name of ["ai", "translations", "domains", "previews", "commerce"]) {
      const off = await instance([], [name]);
      expect(name in (await oldAnswer(off))).toBe(true); // app.ts called the shipped module, loaded or not
      expect(name in (await pluginsReport(off, env))).toBe(false);
    }
  });

  test("and the module and the docs say so, rather than that the shape is unchanged", () => {
    const report = readFileSync(resolvePath(import.meta.dir, "../../src/server/plugins/report.ts"), "utf8");
    const docs = readFileSync(resolvePath(import.meta.dir, "../../docs/plugins.md"), "utf8");
    // what both used to claim, which was true of a plugin that was never there and false of one turned off
    expect(report).not.toContain("exactly as an unloaded plugin was left out of it before");
    expect(docs).not.toContain("exactly as they were only there while the plugin was");
    // and what they have to say instead: which release answered them anyway, and which fields are the core's own
    for (const text of [report, docs]) {
      expect(text).toContain("0.9.0-beta.48");
      for (const name of ["installer", "mail", "payments", "observability"]) expect(text).toContain(name);
    }
  });

  test("what is loaded is the graph half's to say: a field nobody answers for is not the same as a plugin that is gone", async () => {
    const answer = await pluginsReport(await instance([quiet("domains")], ["domains"]), env);
    expect("domains" in answer).toBe(false);
    expect(answer.names).toContain("domains");
    expect(answer.plugins).toContainEqual({ name: "domains", tier: "community", core: false, provides: [], requires: [] });
  });

  test("installer, mail, payments and observability are there whatever is loaded: they are not a plugin's to take away", async () => {
    const kernel = await instance([quiet("installer"), quiet("mail")], ["installer", "mail", "ai", "translations", "domains", "previews", "commerce", "observability"]);
    const answer = await pluginsReport(kernel, env);
    expect(answer).toMatchObject({ installer: installerInfo(env), mail: await mailRoute(env), payments: { via: "none" }, observability: null });
    for (const name of ["ai", "translations", "domains", "previews", "commerce"]) expect(name in answer).toBe(false);
  });
});

// --- a plugin that declares info() is asked, whatever it is called -------------------------------------------------
describe("every loaded plugin with an info() answers, exactly once", () => {
  test("a community plugin under a name of its own answers under that name, after the fields above", async () => {
    const theirs: Plugin = { manifest: { name: "echo", version: "1.0.0", tier: "community", voidbase: "*" }, info: () => ({ heard: true }) };
    const answer = await pluginsReport(await instance([theirs]), env);
    expect(answer.echo).toEqual({ heard: true });
    // appended, so the fields the snapshot pins keep the order and the places they had
    expect(Object.keys(answer).at(-1)).toBe("echo");
  });

  test("and the shipped ones that answer inside commerce are not asked twice", async () => {
    const answer = await pluginsReport(await instance(), env);
    expect("tax-flat" in answer).toBe(false);
    expect("shipping-flat" in answer).toBe(false);
    expect(answer.commerce).toMatchObject({ tax: { rate: 0 }, shipping: { flat: 0, freeOver: 0 } });
  });

  test("with no commerce to answer inside, the two providers answer under their own names instead of nowhere", async () => {
    const answer = await pluginsReport(await instance([], ["commerce"]), env);
    expect("commerce" in answer).toBe(false);
    expect(answer["tax-flat"]).toEqual(taxFlatInfo(env));
    expect(answer["shipping-flat"]).toEqual(shippingFlatInfo(env));
  });

  test("and the condition is commerce's own answer: a commerce that says nothing about itself does it too", async () => {
    // not "with no commerce loaded": the field is there only while something answering under `commerce` has an
    // info(), so a shipped commerce shadowed by a quiet plugin leaves the two providers nowhere to answer inside
    const quiet: Plugin = { manifest: { name: "commerce", version: "2.0.0", tier: "community", voidbase: "*" } };
    const answer = await pluginsReport(await instance([quiet], ["commerce"]), env);
    expect("commerce" in answer).toBe(false);
    expect(answer.names).toContain("commerce");
    expect(answer["tax-flat"]).toEqual(taxFlatInfo(env));
    expect(answer["shipping-flat"]).toEqual(shippingFlatInfo(env));
  });

  test("a plugin named `constructor` is answered: the check is on this answer's own keys, not the prototype's", async () => {
    // the manifest's name rule is lowercase letters, digits and dashes, and `constructor` passes it. `name in
    // answer` is true of it whatever the answer holds, because `in` walks the prototype chain, so such a plugin was
    // dropped with a warning about a field this answer does not have — and the route sent no field for it either.
    const theirs: Plugin = { manifest: { name: "constructor", version: "1.0.0", tier: "community", voidbase: "*" }, info: () => ({ mine: true }) };
    const kernel = await instance([theirs]);
    const logged = spyOn(console, "warn").mockImplementation(() => {});
    const r = await route(kernel);
    expect(r.status).toBe(200);
    const answer = (await r.json()) as Record<string, unknown>;
    expect(Object.hasOwn(answer, "constructor")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(answer, "constructor")?.value).toEqual({ mine: true });
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  test("a plugin named like a field of the graph half is left out rather than allowed to overwrite it", async () => {
    const logged = spyOn(console, "warn").mockImplementation(() => {});
    const liar: Plugin = { manifest: { name: "names", version: "1.0.0", tier: "community", voidbase: "*" }, info: () => ({ not: "a list" }) };
    const answer = await pluginsReport(await instance([liar]), env);
    expect(Array.isArray(answer.names)).toBe(true);
    expect(answer.names).toContain("names");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

// --- what a plugin's answer can do to the route --------------------------------------------------------------------
describe("an info() is held at arm's length by its answer as well as by its call", () => {
  const said = (name: string, info: () => object): Plugin => ({ manifest: { name, version: "2.0.0", tier: "community", voidbase: "*" }, info });

  test("an answer with a cycle in it is that field's failure, not the route's", async () => {
    const logged = quiet();
    const circular: Record<string, unknown> = { hostnames: [] }; circular.self = circular;
    const r = await route(await instance([said("domains", () => circular)], ["domains"]));
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { domains: { error: string }; previews: unknown };
    expect(answer.domains.error).toContain("domains described itself with something that cannot be sent as JSON");
    expect(answer.previews).toEqual(await previewsReport(env)); // and every other plugin still answers
    logged.mockRestore();
  });

  test("an answer whose toJSON throws, and one whose getter throws, are the same failure", async () => {
    const logged = quiet();
    const kernel = await instance([
      said("domains", () => ({ toJSON() { throw new Error("gotcha"); } })),
      said("previews", () => ({ get shape() { throw new Error("getter boom"); } })),
    ], ["domains", "previews"]);
    const r = await route(kernel);
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { domains: { error: string }; previews: { error: string }; installer: unknown };
    expect(answer.domains.error).toContain("gotcha");
    expect(answer.previews.error).toContain("getter boom");
    expect(answer.installer).toEqual(installerInfo(env));
    logged.mockRestore();
  });

  test("an info() that never settles is that field's failure too, rather than a request that never answers", async () => {
    const logged = quiet();
    const kernel = await instance([said("domains", () => new Promise<object>(() => {}))], ["domains"]);
    const answer = await pluginsReport(kernel, env, { timeoutMs: 25 });
    expect(answer.domains).toEqual({ error: "domains did not say what it is within 25ms" });
    expect(answer.previews).toEqual(await previewsReport(env));
    logged.mockRestore();
  });

  test("a promise that rejects is held like a throw", async () => {
    const logged = quiet();
    const kernel = await instance([said("domains", () => Promise.reject(new Error("async boom")) as unknown as object)], ["domains"]);
    expect((await pluginsReport(kernel, env)).domains).toEqual({ error: "async boom" });
    logged.mockRestore();
  });

  test("a plugin whose `info` is a getter that throws fails its own field, not the report before it starts", async () => {
    // reading `info` off the plugin object is reading the plugin's code, and it happens before any call is made:
    // unguarded, a getter that throws here rejected pluginsReport itself and the route answered 500
    const logged = quiet();
    const nasty = { manifest: { name: "domains", version: "2.0.0", tier: "community", voidbase: "*" }, get info(): never { throw new Error("getter on the plugin object"); } } as unknown as Plugin;
    const r = await route(await instance([nasty], ["domains"]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { domains: { error: string }; installer: unknown };
    expect(answer.domains).toEqual({ error: "getter on the plugin object" });
    expect(answer.installer).toEqual(installerInfo(env));
    logged.mockRestore();
  });

  test("the timeout is the whole report's and not each plugin's: four that never answer cost one of them", async () => {
    // every call is started before any is awaited, so the races overlap. Awaited one after another, as this was,
    // four plugins that never settle held the route for four timeouts, and the shipped default is a second each.
    const logged = quiet();
    const hang = (name: string): Plugin => ({ manifest: { name, version: "1.0.0", tier: "community", voidbase: "*" }, info: () => new Promise<object>(() => {}) });
    const kernel = await instance([hang("domains"), hang("echo-1"), hang("echo-2"), hang("echo-3")], ["domains"]);
    const began = Date.now();
    const answer = await pluginsReport(kernel, env, { timeoutMs: 200 });
    const took = Date.now() - began;
    // a named field and three appended ones, so this measures the two halves of the answer overlapping as well
    for (const name of ["domains", "echo-1", "echo-2", "echo-3"]) expect(answer[name]).toEqual({ error: `${name} did not say what it is within 200ms` });
    expect(took).toBeLessThan(400); // one timeout and the rest of the answer; in turn it was over 800
    logged.mockRestore();
  });

  test("and what a field holds is what the route sends: the answer is the value that came back through JSON", async () => {
    const kernel = await instance([said("domains", () => ({ hostnames: ["shop.example"], at: new Date(0), gone: undefined, fn: () => 1 }))], ["domains"]);
    // a Date is a string over the wire and a function is nothing, so the field says what a reader will actually get
    expect((await pluginsReport(kernel, env)).domains).toEqual({ hostnames: ["shop.example"], at: "1970-01-01T00:00:00.000Z" });
  });
});

// --- the two fields answered through an interface ------------------------------------------------------------------
describe("a payments@1 or observability@1 provider is community code too, and is held like an info()", () => {
  // These two are the older seam and the better one — what is reported is the provider's, whatever the plugin
  // providing it is called — but the call is still a call into a plugin, and on an instance that installed one it is
  // exactly the community code the arm's length above exists for. Called raw, as they were, a provider that threw,
  // that never settled or that answered with something JSON cannot take took the whole route down.
  /** an instance of nothing but the plugin under test, so the two fields are that plugin's and nobody else's */
  async function only(plugins: Plugin[]): Promise<Kernel> {
    const kernel = createKernel(new Hono<AppEnv>());
    await load(kernel, plugins, VERSION);
    return kernel;
  }
  const paying = (answer: () => unknown): Plugin => ({
    manifest: { name: "pay-theirs", version: "1.0.0", tier: "community", voidbase: "*", provides: ["payments@1"] },
    apply: (ctx) => { serve<Payments>(ctx, "payments@1", { route: answer } as unknown as Payments); },
  });
  const watching = (answer: () => unknown): Plugin => ({
    manifest: { name: "obs-theirs", version: "1.0.0", tier: "community", voidbase: "*", provides: ["observability@1"] },
    apply: (ctx) => { serve<Observability>(ctx, "observability@1", { sample: (async (_c: unknown, next: () => unknown) => next()), report: answer } as unknown as Observability); },
  });

  test("a payments provider that throws is that one field, through a mounted route that still answers 200", async () => {
    const logged = quiet();
    const r = await route(await only([paying(() => { throw new Error("payments provider blew up"); })]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { payments: { error: string }; names: string[]; installer: unknown };
    expect(answer.payments).toEqual({ error: "payments provider blew up" }); // and not `crashed`, which is the 500
    expect(answer.names).toEqual(["pay-theirs"]); // the graph half still stands
    expect(answer.installer).toEqual(installerInfo(env));
    logged.mockRestore();
  });

  test("an observability provider that throws is the same failure, named for the plugin providing it", async () => {
    const logged = quiet();
    const r = await route(await only([watching(() => { throw new Error("observability provider blew up"); })]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { observability: unknown }).observability).toEqual({ error: "observability provider blew up" });
    logged.mockRestore();
  });

  test("an answer with a cycle in it never reaches c.json(): it went through JSON here, where it is one field", async () => {
    const logged = quiet();
    const cycle: Record<string, unknown> = { via: "theirs", webhook: "/x", livemode: false }; cycle.self = cycle;
    const r = await route(await only([paying(() => cycle)]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { payments: { error: string } };
    expect(answer.payments.error).toContain("pay-theirs described itself with something that cannot be sent as JSON");
    logged.mockRestore();
  });

  test("and one whose toJSON throws, which is the same value the route could not have sent", async () => {
    const logged = quiet();
    const r = await route(await only([watching(() => ({ toJSON() { throw new Error("gotcha"); } }))]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { observability: { error: string } }).observability.error).toContain("gotcha");
    logged.mockRestore();
  });

  test("and a provider whose method is a getter that throws: the implementation is read inside the gate too", async () => {
    const logged = quiet();
    // cordis hands back the object the plugin registered, so reading the method off it is already a plugin's code
    const hostile: Plugin = {
      manifest: { name: "pay-theirs", version: "1.0.0", tier: "community", voidbase: "*", provides: ["payments@1"] },
      apply: (ctx) => { serve<Payments>(ctx, "payments@1", { get route(): never { throw new Error("lazy route getter blew up"); } } as unknown as Payments); },
    };
    const r = await route(await only([hostile]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { payments: { error: string } }).payments).toEqual({ error: "lazy route getter blew up" });
    logged.mockRestore();
  });

  test("a manifest field the route could not have sent is that part of the graph half, not the whole answer", async () => {
    const logged = quiet();
    // a manifest is an installed bundle's own file: checkManifest judges the names in it, not the shape of a tier
    const tier: Record<string, unknown> = {}; tier.self = tier;
    const odd: Plugin = { manifest: { name: "odd-tier", version: "1.0.0", tier: tier as never, voidbase: "*" }, apply: () => {} };
    const r = await route(await only([odd]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { names: string[]; tiers: { error: string }; installer: unknown };
    expect(answer.names).toEqual(["odd-tier"]);
    expect(typeof answer.tiers.error).toBe("string");
    expect(answer.installer).toEqual(installerInfo(env));
    logged.mockRestore();
  });

  test("a provider that never settles is a failed field rather than a request that never answers", async () => {
    const logged = quiet();
    const began = Date.now();
    const r = await route(await only([watching(() => new Promise(() => {}))]), { timeoutMs: 50 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { observability: unknown }).observability).toEqual({ error: "obs-theirs did not say what it is within 50ms" });
    expect(Date.now() - began).toBeLessThan(1000);
    logged.mockRestore();
  });

  test("and an answer that is not an object: a field of this answer is an object or it is an error", async () => {
    const logged = spyOn(console, "warn").mockImplementation(() => {});
    const answer = await pluginsReport(await only([paying(() => "somewhere")]), env, { timeoutMs: 50 });
    expect(answer.payments).toEqual({ error: "pay-theirs answered string rather than an object" });
    logged.mockRestore();
  });

  test("the defaults are the core's own and are what they were: no provider, and a provider with no key here", async () => {
    expect(await pluginsReport(await only([]), env)).toMatchObject({ payments: { via: "none" }, observability: null });
    // payments@1's route() answers null when that provider has no key in these bindings, which is not a failure
    expect((await pluginsReport(await only([paying(() => null)]), env)).payments).toEqual({ via: "none" });
    expect((await pluginsReport(await only([watching(() => null)]), env)).observability).toBeNull();
    // and a provider that does answer is answered, which is what these two fields were always for
    const said = { via: "theirs", webhook: "/api/theirs/webhook", livemode: false };
    expect((await pluginsReport(await only([paying(() => said)]), env)).payments).toEqual(said);
  });
});

// --- the core does not import a plugin -------------------------------------------------------------------------
describe("report.ts answers for the installer without importing the installer plugin", () => {
  const source = (file: string) => readFileSync(resolvePath(import.meta.dir, "../../src/server", file), "utf8");

  test("the only thing report.ts imports from the plugins directory is the manifest's types", () => {
    // the core importing a plugin is the edge this phase exists to remove, and the first thing that would block
    // lifting the installer into a package of its own: where an instance's plugins live is the core's own fact and
    // lives in src/server/installer-info.ts, which the plugin reads too.
    const report = source("plugins/report.ts");
    expect(report).not.toContain('from "./installer"');
    const relative = [...report.matchAll(/^import\b[^\n]*?from "(\.[^"]*)";$/gm)].map((m) => m[1]!);
    expect(relative.filter((i) => !i.startsWith("../"))).toEqual(["./manifest"]);
    expect(relative).toContain("../installer-info");
  });

  test("and the plugin reads the same module, so the field says the same thing either way", async () => {
    expect(source("plugins/installer.ts")).toContain('from "../installer-info"');
    // loaded, the field is the plugin's own info(), which is installerInfo bound to the filesystem it was given
    expect((await pluginsReport(await instance(), env)).installer).toEqual(installerInfo(env));
    // turned off in voidbase.lock, the core answers it from the same function rather than the field going missing
    expect((await pluginsReport(await instance([], ["installer"]), env)).installer).toEqual(installerInfo(env));
  });
});

// --- the realtime slot ------------------------------------------------------------------------------------------
describe("an instance whose realtime plugin is not there", () => {
  test("realtime@1 is not in CORE, so nothing warns: the guard is the whole of what keeps the instance up", async () => {
    expect(CORE).not.toContain("realtime@1");
    const kernel = await instance([], ["realtime"]);
    expect(whatLoaded(kernel).missingCore).toEqual([]);
    expect(whatLoaded(kernel).providers["realtime@1"]).toBeUndefined();
  });

  test("the slot answers a client that says realtime is off, where reading it unguarded threw", async () => {
    const kernel = await instance([], ["realtime"]);
    expect(using<Realtime | undefined>(kernel, "realtime@1")).toBeUndefined();
    // what app.ts did on every request before the guard: .for(env) on nothing
    expect(() => using<Realtime>(kernel, "realtime@1").for(env)).toThrow();
    const client = realtimeOf(using<Realtime | undefined>(kernel, "realtime@1"), env);
    expect(client).toBe(realtimeOff);
    expect(client.active()).toBe(false);
    await expect(client.publish([{ collection: "posts", recordId: "p1", action: "create" }])).resolves.toBeUndefined();
    expect(await client.presence("beat", { id: "" }, { max: 3, ttlMs: 1000 })).toBeNull();
    expect(await client.publishToClient("c1", "@oauth2", {})).toBe(false);
  });

  test("with the plugin, the same slot hands over the plugin's own client", async () => {
    const kernel = await instance();
    expect(realtimeOf(using<Realtime | undefined>(kernel, "realtime@1"), env)).not.toBe(realtimeOff);
  });

  // app.ts sets the client on the context in its first middleware and the presence routes ask it `active()`; both
  // are rebuilt here over a small app, the way the observability test rebuilds the slot it measures
  async function appWithout(name: string) {
    const app = new Hono<AppEnv>();
    const kernel = createKernel(app);
    app.use("*", async (c, next) => { c.set("realtime", realtimeOf(using<Realtime | undefined>(kernel, "realtime@1"), c.env)); await next(); });
    app.get("/api/health", (c) => c.json({ message: "API is healthy.", code: 200, data: {} }));
    app.get("/api/presence", (c) => {
      const client = c.get("realtime");
      if (!presenceEnabled(c.env) || !client.active()) return c.json({ enabled: false, max: 0, members: [] });
      return c.json({ enabled: true, max: 3, members: [] });
    });
    await load(kernel, [realtime, hardening].filter((p) => p.manifest.name !== name), VERSION);
    return app;
  }

  test("a normal request is answered, and presence says realtime is off rather than failing", async () => {
    const app = await appWithout("realtime");
    const on = { VOIDBASE_PRESENCE: "1" } as unknown as Bindings;
    expect((await app.request("http://shop.example/api/health", {}, on)).status).toBe(200);
    expect(await (await app.request("http://shop.example/api/presence", {}, on)).json()).toEqual({ enabled: false, max: 0, members: [] });
  });
});
