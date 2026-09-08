// What the plugin kernel costs, and whether Hono tolerates being mounted late.
//
// Two questions the experiment has to answer before any of it is worth landing:
//
//   1. Cold start. A Worker builds the kernel once per isolate, so the graph is paid on a cold start rather than
//      per request. The comparison pages claim a Worker starts in about five milliseconds; a container that costs
//      more than that would be spending the number the whole argument rests on.
//   2. Late mounting. Bindings arrive with the request on Cloudflare, so a service that wraps one cannot be
//      registered until the first request. If Hono's router will not accept routes after it has matched once, the
//      kernel has to mount everything at module scope and only the services can be lazy.
import { Context, Service } from "cordis";
import { Hono } from "hono";

class Hub extends Service {
  constructor(ctx: Context) { super(ctx, "hub"); }
  ping() { return true; }
}
declare module "cordis" { interface Context { hub: Hub } }

const ROUNDS = 200;

async function buildKernel(plugins: number) {
  const app = new Hono();
  const ctx = new Context() as Context & { app: Hono };
  ctx.app = app;
  const fibers: unknown[] = [];
  fibers.push(ctx.plugin(Hub));
  for (let i = 0; i < plugins; i++) {
    fibers.push(
      ctx.plugin({
        name: `plugin-${i}`,
        inject: { hub: false },
        apply(c: Context & { app: Hono }) { c.app.get(`/api/p${i}`, (x) => x.text("ok")); },
      }),
    );
  }
  await Promise.all(fibers as Promise<unknown>[]);
  return app;
}

function bare(plugins: number) {
  const app = new Hono();
  for (let i = 0; i < plugins; i++) app.get(`/api/p${i}`, (x) => x.text("ok"));
  return app;
}

const time = async (label: string, n: number, run: () => unknown | Promise<unknown>) => {
  await run(); // warm the JIT the same way a second isolate would not be
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await run();
  const each = (performance.now() - t0) / n;
  console.log(`  ${label.padEnd(34)} ${each.toFixed(3)} ms`);
  return each;
};

console.log("Building an app, per construction:");
for (const n of [12, 40]) {
  const withKernel = await time(`${n} plugins through cordis`, ROUNDS, () => buildKernel(n));
  const without = await time(`${n} routes mounted directly`, ROUNDS, async () => bare(n));
  console.log(`  ${"the container costs".padEnd(34)} ${(withKernel - without).toFixed(3)} ms\n`);
}

console.log("Does Hono accept routes after it has served one?");
const app = new Hono();
app.get("/api/early", (c) => c.text("early"));
const early = await app.request("/api/early");
const lateBefore = await app.request("/api/late");
app.get("/api/late", (c) => c.text("late"));
const lateAfter = await app.request("/api/late");
console.log(`  a route mounted before the first request   ${early.status}`);
console.log(`  the same path before it was mounted        ${lateBefore.status}`);
console.log(`  and after, on a router that already served ${lateAfter.status} ${lateAfter.status === 200 ? "(late mounting works)" : "(late mounting does NOT work)"}`);
