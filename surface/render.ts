#!/usr/bin/env bun
/**
 * Renders surface.json into dist/surface.html and prints a terminal summary.
 *
 *   bun surface/render.ts            # render + summary
 *   bun surface/render.ts --check    # validate only, exit 1 on problems
 *
 * surface.json is the source of truth. Flip an item's "status" there
 * (todo | partial | done | deferred | out), re-run, republish the HTML.
 */

type Status = "todo" | "partial" | "done" | "deferred" | "out";
interface Item {
  id: string;
  title: string;
  surface?: string;
  oracles: string[];
  hours: number;
  status: Status;
  milestone: string;
  verify?: string;
  notes?: string;
}
interface Area { id: string; title: string; summary: string; items: Item[] }
interface Surface {
  name: string;
  updated: string;
  statuses: Record<Status, { label: string; weight: number; counts: boolean }>;
  oracles: { id: string; label: string }[];
  milestones: { id: string; title: string }[];
  areas: Area[];
}

const dir = import.meta.dir;
const checkOnly = process.argv.includes("--check");
const surface = (await Bun.file(`${dir}/surface.json`).json()) as Surface;

// ---- validate -------------------------------------------------------------
const problems: string[] = [];
const ids = new Set<string>();
const oracleIds = new Set(surface.oracles.map((o) => o.id));
const milestoneIds = new Set(surface.milestones.map((m) => m.id));
for (const area of surface.areas) {
  for (const it of area.items) {
    if (ids.has(it.id)) problems.push(`duplicate id ${it.id}`);
    ids.add(it.id);
    if (!(it.status in surface.statuses)) problems.push(`${it.id}: unknown status ${it.status}`);
    if (typeof it.hours !== "number" || it.hours < 0) problems.push(`${it.id}: bad hours`);
    if (!milestoneIds.has(it.milestone)) problems.push(`${it.id}: unknown milestone ${it.milestone}`);
    for (const o of it.oracles) if (!oracleIds.has(o)) problems.push(`${it.id}: unknown oracle ${o}`);
  }
}
if (problems.length) {
  console.error("surface.json problems:\n  " + problems.join("\n  "));
  process.exit(1);
}
if (checkOnly) {
  console.log("surface.json ok");
  process.exit(0);
}

// ---- progress -------------------------------------------------------------
const all = surface.areas.flatMap((a) => a.items);
function progress(items: Item[]) {
  const counted = items.filter((i) => surface.statuses[i.status].counts);
  const total = counted.reduce((s, i) => s + i.hours, 0);
  const earned = counted.reduce((s, i) => s + i.hours * surface.statuses[i.status].weight, 0);
  const n = (st: Status) => counted.filter((i) => i.status === st).length;
  return { total, earned, pct: total ? (earned / total) * 100 : 0, done: n("done"), partial: n("partial"), todo: n("todo"), items: counted.length };
}
const bar = (pct: number, w = 28) => {
  const f = Math.round((pct / 100) * w);
  return "█".repeat(f) + "░".repeat(w - f);
};
const line = (label: string, p: ReturnType<typeof progress>) =>
  `${label.padEnd(30)} ${bar(p.pct)} ${p.pct.toFixed(1).padStart(5)}%  ${p.earned.toFixed(1).padStart(6)}/${p.total.toFixed(1)}h  done ${p.done} partial ${p.partial} todo ${p.todo}`;

const overall = progress(all);
console.log(`\n${surface.name} surface map  (updated ${surface.updated})\n`);
console.log(line("OVERALL", overall));
console.log("\nfinish lines");
for (const o of surface.oracles) console.log(line("  " + o.label, progress(all.filter((i) => i.oracles.includes(o.id)))));
console.log("\nmilestones");
for (const m of surface.milestones) console.log(line("  " + m.id + " " + m.title, progress(all.filter((i) => i.milestone === m.id))));
console.log("\nareas");
for (const a of surface.areas) console.log(line("  " + a.title, progress(a.items)));
const deferred = all.filter((i) => i.status === "deferred").length;
const out = all.filter((i) => i.status === "out").length;
console.log(`\n${all.length} items: ${overall.items} counted, ${deferred} deferred, ${out} out of scope\n`);

// ---- render ---------------------------------------------------------------
const template = await Bun.file(`${dir}/template.html`).text();
const json = JSON.stringify(surface).replace(/<\/script/gi, "<\\/script");
const html = template.replace("/*__SURFACE_JSON__*/null", json);
const outPath = `${dir}/dist/surface.html`;
await Bun.write(outPath, html);
console.log(`wrote ${outPath}`);
