// The loader's failures, which are the part cordis does not have.
//
// Each of these is a promise the roadmap makes about what happens at install rather than at boot, and each was
// measured to be something cordis does not do: two providers of one interface are accepted silently and the first
// wins, a cycle deadlocks with nothing thrown. So they are checked here, over the manifests, before anything is
// handed to a container.
import { describe, expect, test } from "bun:test";
import { checkManifest, type Plugin, type PluginManifest } from "../../src/server/plugins/manifest";
import { CORE, resolve, satisfies } from "../../src/server/plugins/resolve";
import { Hono } from "hono";
import { createKernel, load, serve, using, whatLoaded } from "../../src/server/kernel";

const plugin = (m: Partial<PluginManifest> & { name: string }): Plugin => ({
  manifest: { version: "1.0.0", tier: "community", voidbase: "*", ...m },
});

const problemsOf = (plugins: Plugin[], version = "0.9.0") => resolve(plugins, version).problems;

describe("what a manifest has to say", () => {
  test("a name is lowercase, and an interface is name@major", () => {
    expect(checkManifest({ name: "Backups", version: "1.0.0", tier: "official", voidbase: "*" })[0]).toContain("lowercase");
    expect(checkManifest({ name: "pay", version: "1.0.0", tier: "official", voidbase: "*", provides: ["payments" as never] })[0]).toContain("name@major");
  });

  test("a plugin without a voidbase range cannot be checked against one, so it is refused", () => {
    expect(checkManifest({ name: "x", version: "1.0.0", tier: "community", voidbase: "" }).join()).toContain("no voidbase range");
  });

  test("owning and extending the same collection is one or the other", () => {
    const wrong = checkManifest({
      name: "x", version: "1.0.0", tier: "community", voidbase: "*",
      collections: ["orders"], extends: { orders: [{ name: "note", type: "text" }] },
    });
    expect(wrong.join()).toContain("both owns and extends");
  });
});

describe("the four failures the loader owns", () => {
  test("two providers of one interface are refused, and both are named", () => {
    const problems = problemsOf([
      plugin({ name: "stripe", provides: ["payments@1"] }),
      plugin({ name: "polar", provides: ["payments@1"] }),
    ]);
    expect(problems.join()).toContain("stripe and polar both provide");
    expect(problems.join()).toContain("ambiguous");
  });

  test("a required interface nothing provides names the interface and who wanted it", () => {
    const problems = problemsOf([plugin({ name: "checkout", requires: ["payments@1"] })]);
    expect(problems.join()).toContain('checkout requires "payments@1"');
  });

  test("a cycle is refused, and the circle is printed", () => {
    const problems = problemsOf([
      plugin({ name: "a", provides: ["auth@1"], requires: ["mail@1"] }),
      plugin({ name: "b", provides: ["mail@1"], requires: ["auth@1"] }),
    ]);
    expect(problems.join()).toContain("depend on each other in a circle");
    expect(problems.join()).toContain("a -> b -> a");
  });

  test("an interface this voidbase does not define is a typo, and is refused", () => {
    const problems = problemsOf([plugin({ name: "x", requires: ["payjments@1" as never] })]);
    expect(problems.join()).toContain('names the interface "payjments@1", which this voidbase does not define');
  });

  test("a plugin that does not fit this voidbase is refused at install", () => {
    expect(problemsOf([plugin({ name: "old", voidbase: "^0.7.0" })], "0.9.0").join()).toContain("works against voidbase ^0.7.0");
    expect(problemsOf([plugin({ name: "fine", voidbase: "^0.9.0" })], "0.9.0")).toEqual([]);
  });
});

describe("who owns a collection", () => {
  test("two plugins cannot own one collection", () => {
    const problems = problemsOf([
      plugin({ name: "shop", collections: ["orders"] }),
      plugin({ name: "billing", collections: ["orders"] }),
    ]);
    expect(problems.join()).toContain('both own the collection "orders"');
  });

  test("extending a collection nobody owns is caught at install, not at boot", () => {
    const problems = problemsOf([plugin({ name: "stripe", extends: { users: [{ name: "customerId", type: "text" }] } })]);
    expect(problems.join()).toContain('extends the collection "users", which no installed plugin owns');
  });

  test("an extension loads after the plugin that owns what it extends", () => {
    const { order, problems } = resolve([
      plugin({ name: "stripe", extends: { users: [{ name: "customerId", type: "text" }] } }),
      plugin({ name: "auth", collections: ["users"] }),
    ], "0.9.0");
    expect(problems).toEqual([]);
    expect(order.map((p) => p.manifest.name)).toEqual(["auth", "stripe"]);
  });
});

describe("load order", () => {
  test("everything a plugin requires comes before it", () => {
    const { order, problems } = resolve([
      plugin({ name: "checkout", requires: ["payments@1", "auth@1"] }),
      plugin({ name: "stripe", provides: ["payments@1"], requires: ["auth@1"] }),
      plugin({ name: "better-auth", provides: ["auth@1"] }),
    ], "0.9.0");
    expect(problems).toEqual([]);
    const at = (n: string) => order.findIndex((p) => p.manifest.name === n);
    expect(at("better-auth")).toBeLessThan(at("stripe"));
    expect(at("stripe")).toBeLessThan(at("checkout"));
  });

  test("swapping the provider changes nothing for what required it", () => {
    const withStripe = resolve([
      plugin({ name: "checkout", requires: ["payments@1"] }),
      plugin({ name: "stripe", provides: ["payments@1"] }),
    ], "0.9.0");
    const withPolar = resolve([
      plugin({ name: "checkout", requires: ["payments@1"] }),
      plugin({ name: "polar", provides: ["payments@1"] }),
    ], "0.9.0");
    expect(withStripe.problems).toEqual([]);
    expect(withPolar.problems).toEqual([]);
    expect(withStripe.order.at(-1)!.manifest.name).toBe("checkout");
    expect(withPolar.order.at(-1)!.manifest.name).toBe("checkout");
  });
});

describe("the version ranges a manifest may use", () => {
  test("exact, caret, tilde and comparisons", () => {
    expect(satisfies("0.9.0", "0.9.0")).toBe(true);
    expect(satisfies("0.9.1", "0.9.0")).toBe(false);
    expect(satisfies("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.9.5", "~0.9.0")).toBe(true);
    expect(satisfies("0.10.0", "~0.9.0")).toBe(false);
    expect(satisfies("0.9.0", ">=0.8.0")).toBe(true);
    expect(satisfies("0.9.0", "*")).toBe(true);
    expect(satisfies("0.9.0", "^0.8.0 || ^0.9.0")).toBe(true);
  });

  test("below 1.0.0 the caret keeps the minor, which is what every 0.x depends on", () => {
    expect(satisfies("0.9.4", "^0.9.0")).toBe(true);
    expect(satisfies("0.10.0", "^0.9.0")).toBe(false);
  });

  test("a prerelease of this voidbase satisfies a range written against it", () => {
    expect(satisfies("0.9.0-beta.2", "^0.9.0")).toBe(true);
  });
});

describe("the kernel refuses a graph it cannot load", () => {
  const kernelFor = () => createKernel(new Hono() as never);

  test("nothing is applied when anything is wrong, and every problem is reported at once", async () => {
    let applied = 0;
    const bad = [
      { manifest: { name: "stripe", version: "1.0.0", tier: "community" as const, voidbase: "*", provides: ["payments@1" as const] }, apply: () => { applied++; } },
      { manifest: { name: "polar", version: "1.0.0", tier: "community" as const, voidbase: "*", provides: ["payments@1" as const] }, apply: () => { applied++; } },
      { manifest: { name: "lost", version: "1.0.0", tier: "community" as const, voidbase: "*", requires: ["mail@1" as const] }, apply: () => { applied++; } },
    ];
    const err = await load(kernelFor(), bad, "0.9.0").then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("both provide");
    expect(err!.message).toContain('lost requires "mail@1"');
    expect(applied).toBe(0);
  });

  test("a good graph applies in order and says what it is running", async () => {
    const ran: string[] = [];
    const kernel = kernelFor();
    const result = await load(kernel, [
      { manifest: { name: "checkout", version: "1.0.0", tier: "community", voidbase: "*", requires: ["payments@1"] },
        apply: (ctx) => { ran.push(`checkout via ${using<{ who: string }>(ctx, "payments@1").who}`); } },
      { manifest: { name: "stripe", version: "1.0.0", tier: "official", voidbase: "*", provides: ["payments@1"] },
        apply: (ctx) => { ran.push("stripe"); serve(ctx, "payments@1", { who: "stripe" }); } },
    ], "0.9.0");
    expect(ran).toEqual(["stripe", "checkout via stripe"]);
    expect(result.names).toEqual(["stripe", "checkout"]);
    expect(result.providers["payments@1"]).toBe("stripe");
    expect(result.tiers.stripe).toBe("official");
    expect(whatLoaded(kernel).names).toEqual(["stripe", "checkout"]);
  });
});

describe("the tier that is not optional", () => {
  test("an instance with no provider for a core interface says so rather than pretending it is lean", () => {
    const { missingCore, problems } = resolve([plugin({ name: "backups" })], "0.9.0", ["auth@1"]);
    expect(problems).toEqual([]);
    expect(missingCore).toEqual(["auth@1"]);
  });

  test("and stops saying so once something provides it", () => {
    const { missingCore } = resolve([plugin({ name: "better-auth", tier: "core", provides: ["auth@1"] })], "0.9.0", ["auth@1"]);
    expect(missingCore).toEqual([]);
  });

  test("auth is core, since it left the core: an instance without a provider says so with the default list", () => {
    expect(CORE).toEqual(["auth@1"]);
    expect(resolve([plugin({ name: "backups" })], "0.9.0").missingCore).toEqual(["auth@1"]);
  });

  test("removing a core plugin is possible, which is the entire point of moving auth out", () => {
    // not a refusal: the graph loads, and the instance reports what it is missing
    const { problems, order, missingCore } = resolve([plugin({ name: "backups" })], "0.9.0");
    expect(problems).toEqual([]);
    expect(order.map((p) => p.manifest.name)).toEqual(["backups"]);
    expect(missingCore).toEqual(["auth@1"]);
  });
});

describe("what happens when a provider goes away", () => {
  // The property the whole system rests on, measured rather than assumed: cordis marks a fiber's state, and that is
  // the observable. An `on("dispose")` hook is not, which is how an earlier version of this claim was wrong.
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const state = (fiber: unknown) => (fiber as { state: number }).state;
  const dispose = (fiber: unknown) => (fiber as { dispose(): Promise<void> }).dispose();

  test("removing a provider unloads what required it, and a replacement reloads it, untouched", async () => {
    const kernel = createKernel(new Hono() as never);
    let applied = 0;
    const stripe = kernel.plugin({ name: "stripe", apply: (ctx) => { serve(ctx as never, "payments@1", { who: "stripe" }); } });
    await stripe;
    const checkout = kernel.plugin({ name: "checkout", inject: ["payments@1"], apply: () => { applied++; } });
    await checkout;
    expect(applied).toBe(1);
    expect(state(checkout)).toBe(2); // active

    await dispose(stripe); await tick();
    expect(state(checkout)).toBe(0); // waiting: its interface is gone, so it was torn down
    expect(using(kernel, "payments@1")).toBeUndefined();

    kernel.plugin({ name: "polar", apply: (ctx) => { serve(ctx as never, "payments@1", { who: "polar" }); } });
    await tick();
    expect(applied).toBe(2); // re-applied against the new provider, without checkout changing
    expect(state(checkout)).toBe(2);
    expect(using<{ who: string }>(kernel, "payments@1").who).toBe("polar");
  });
});
