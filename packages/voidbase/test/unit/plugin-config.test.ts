// A plugin's configuration plane (src/server/plugins/config.ts): what a manifest may declare, where a value comes from,
// that a runtime field takes effect at once and a rebuild field waits, that a project's configuration is read only on
// the instance, and the config.json an extended project gets when it adds a plugin.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { d1 } from "../../src/node/d1";
import { projectConfigOf, writeDefaultConfig } from "../../src/node/installed";
import { configKnob, configReport, declareConfig } from "../../src/server/plugins/config";
import { setPluginConfig } from "../../src/server/plugins/config-store";
import { checkManifest, type PluginManifest } from "../../src/server/plugins/manifest";
import { readKnob, responsePolicy } from "../../src/server/response-policy";

const ROOT = resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const shield: PluginManifest = {
  name: "shield", version: "0.1.0", tier: "community", voidbase: "*",
  config: {
    referrer_policy: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_REFERRER_POLICY" },
    sample_rate: { type: "number", applies: "rebuild", default: 1 },
  },
};

function database() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  }
  return d1(sqlite);
}

beforeEach(() => declareConfig([shield]));

test("a manifest's configuration fields are checked with the rest of it", () => {
  expect(checkManifest(shield)).toEqual([]);
  const wrong = checkManifest({ ...shield, config: { "Bad-Name": { type: "date", applies: "sometimes", default: 3, knob: "lower" } as never } });
  expect(wrong).toHaveLength(5);
  expect(checkManifest({ ...shield, config: { level: { type: "string", applies: "runtime", default: 3 as never } } })[0]).toContain("defaults to a number, and it is a string");
});

test("a field reads the environment first, then its default; a field nobody declares is not answered", () => {
  expect(configKnob("VOIDBASE_SHIELD_SAMPLE_RATE")).toBe("1");
  expect(configKnob("VOIDBASE_NOT_DECLARED")).toBeUndefined();
  expect(readKnob("VOIDBASE_REFERRER_POLICY", { VOIDBASE_REFERRER_POLICY: "origin" })).toBe("origin");
});

test("on a vanilla instance a runtime field takes effect at once and a rebuild field waits for the next rebuild", async () => {
  const db = database();
  const r = await setPluginConfig(db, "shield", { referrer_policy: "no-referrer", sample_rate: "0.25" });
  expect(r).toMatchObject({ applied: ["referrer_policy"], waitsForRebuild: ["sample_rate"] });
  expect(r.message).toBe("referrer_policy took effect. sample_rate waits for the next rebuild.");
  // the knob the plugin reads per request has the new value
  expect(responsePolicy({}).referrerPolicy).toBe("no-referrer");
  // the rebuild field still reads what the instance started with, and the report says what waits
  expect(configKnob("VOIDBASE_SHIELD_SAMPLE_RATE")).toBe("1");
  const report = configReport(() => undefined).shield!;
  expect(report.editable).toBe(true);
  expect(report.fields.referrer_policy).toMatchObject({ applies: "runtime", value: "no-referrer", source: "instance" });
  expect(report.fields.sample_rate).toMatchObject({ applies: "rebuild", value: 1, source: "default", pending: 0.25 });
  // what the environment sets wins over the plane, and says so
  expect(configReport((k) => (k === "VOIDBASE_REFERRER_POLICY" ? "origin" : undefined)).shield!.fields.referrer_policy).toMatchObject({ value: "origin", source: "environment" });
  await expect(setPluginConfig(db, "shield", { sample_rate: "lots" })).rejects.toThrow("sample_rate must be a number");
  await expect(setPluginConfig(db, "shield", { colour: "red" })).rejects.toThrow("shield declares no field called colour");
  await expect(setPluginConfig(db, "nothing", {})).rejects.toThrow("not a loaded plugin with a configuration plane");
});

test("on an extended project the configuration is a committed file, read only on the instance", async () => {
  const d = mkdtempSync(join(tmpdir(), "vb-config-")); dirs.push(d);
  const plugins = join(d, "pb_plugins"); mkdirSync(join(plugins, "shield"), { recursive: true });
  writeDefaultConfig(join(plugins, "shield"), shield.config);
  expect(JSON.parse(readFileSync(join(plugins, "shield/config.json"), "utf8"))).toEqual({ referrer_policy: "", sample_rate: 1 });
  // the developer's edit is the project's, and adding the plugin again keeps it
  writeFileSync(join(plugins, "shield/config.json"), JSON.stringify({ referrer_policy: "same-origin", sample_rate: 0.5 }));
  writeDefaultConfig(join(plugins, "shield"), shield.config);
  expect(projectConfigOf(plugins)).toEqual({ shield: { referrer_policy: "same-origin", sample_rate: 0.5 } });

  declareConfig([shield], projectConfigOf(plugins));
  expect(responsePolicy({}).referrerPolicy).toBe("same-origin");
  expect(configReport(() => undefined).shield).toMatchObject({ editable: false, fields: { sample_rate: { value: 0.5, source: "project" } } });
  await expect(setPluginConfig(database(), "shield", { referrer_policy: "no-referrer" })).rejects.toThrow("change it there, commit it, and let the build carry it");
});
