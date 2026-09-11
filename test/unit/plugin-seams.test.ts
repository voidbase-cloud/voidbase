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
import { installer, installerInfo } from "../../src/server/plugins/installer";
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
    for (const file of ["plugins/auth.ts", "plugins/seo.ts", "auth.ts", "webauthn.ts"]) {
      expect(source(file)).not.toContain('import("./app")');
      expect(source(file)).not.toContain('import("../app")');
      expect(source(file)).toContain('record-slot"');
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

  // This is the change 0.9.0-beta.46 made to what every instance reports about itself, and it is pinned here name
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
  /** the route as app.ts mounts it: c.json() serialises the whole answer at once, which is where a bad value lands */
  async function route(kernel: Kernel, opts: { timeoutMs?: number } = {}): Promise<Response> {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.json({ crashed: err instanceof Error ? err.message : String(err) }, 500));
    app.get("/api/plugins", async (c) => c.json(await pluginsReport(kernel, c.env, opts)));
    return app.request("http://shop.example/api/plugins", {}, env as unknown as Bindings);
  }
  const said = (name: string, info: () => object): Plugin => ({ manifest: { name, version: "2.0.0", tier: "community", voidbase: "*" }, info });
  const quiet = () => spyOn(console, "error").mockImplementation(() => {});

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

  test("and what a field holds is what the route sends: the answer is the value that came back through JSON", async () => {
    const kernel = await instance([said("domains", () => ({ hostnames: ["shop.example"], at: new Date(0), gone: undefined, fn: () => 1 }))], ["domains"]);
    // a Date is a string over the wire and a function is nothing, so the field says what a reader will actually get
    expect((await pluginsReport(kernel, env)).domains).toEqual({ hostnames: ["shop.example"], at: "1970-01-01T00:00:00.000Z" });
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
