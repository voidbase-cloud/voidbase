// The collections a plugin owns, created by the plugin itself.
//
// A manifest names the collections a plugin owns so that two plugins claiming one name collide at install rather
// than at boot. Owning one also means creating it: the plugin asks for it here, at bootstrap (kernel onBootstrap),
// with the same definition the collections API takes, and it is created through the same service the panel uses,
// table and all, once, when it is missing. A collection the manifest does not name is refused before anything is
// touched, because a plugin creating what it did not declare is exactly what the ownership rule exists to stop.
// The auth plugin's five collections are the exception that predates this: they are system tables voidbase's own
// schema creates, and the manifest owns them so nothing else can.
import { collectionToJSON, findCollection, type Collection } from "../collections/model";
import { createCollection, updateCollection } from "../collections/service";
import { logger } from "#platform/log";
import type { Plugin } from "./manifest";

const RULES = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"] as const;
const indexName = (sql: string): string => /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([^`"'\s(]+)/i.exec(sql)?.[1]?.toLowerCase() ?? sql;

/**
 * What a newer definition adds to a collection the plugin created earlier: fields it lacks (by name), indexes it
 * lacks (by text) and rules that changed. Fields the instance has and the definition no longer names are kept, as
 * are their options: a plugin reconciles its own shape forward, it does not drop a column with data in it.
 */
export function reconcileDefinition(existing: Collection, def: Record<string, unknown>): Record<string, unknown> | null {
  const have = new Set(existing.fields.map((f) => f.name));
  const fields = ((def.fields as { name: string }[] | undefined) ?? []).filter((f) => !have.has(f.name));
  // an index is known by its name: the definition's text replaces an existing index of that name (the columns
  // changed with the fields), and a name the instance lacks is added
  const wanted = ((def.indexes as string[] | undefined) ?? []);
  const byName = new Map(wanted.map((i) => [indexName(i), i] as const));
  const indexes = existing.indexes.map((i) => byName.get(indexName(i)) ?? i);
  for (const i of wanted) if (!existing.indexes.some((e) => indexName(e) === indexName(i))) indexes.push(i);
  const indexesChanged = indexes.length !== existing.indexes.length || indexes.some((i, n) => i !== existing.indexes[n]);
  const rules: Record<string, unknown> = {};
  for (const r of RULES) if (r in def && (def[r] ?? null) !== (existing[r] ?? null)) rules[r] = def[r] ?? null;
  if (!fields.length && !indexesChanged && !Object.keys(rules).length) return null;
  return { ...collectionToJSON(existing), ...rules, fields: [...existing.fields, ...fields], indexes };
}

/**
 * create the owned collections that are missing, and bring the ones that exist up to the definition (a field, an
 * index or a rule a newer version of the plugin declares); returns the names created
 */
export async function ensureCollections(plugin: Plugin, db: D1Database, definitions: Record<string, unknown>[]): Promise<string[]> {
  const owned = new Set(plugin.manifest.collections ?? []);
  for (const def of definitions) {
    const name = String(def.name ?? "");
    if (!owned.has(name)) throw new Error(`voidbase: ${plugin.manifest.name} creates the collection "${name}" without owning it; list it under "collections" in the manifest, which is what lets the loader refuse a second owner at install`);
  }
  const created: string[] = [];
  for (const def of definitions) {
    const name = String(def.name);
    const existing = await findCollection(db, name);
    if (existing) {
      const next = reconcileDefinition(existing, def);
      if (next) {
        // a shape the instance refuses (a hand-made change in the way, say) must not take every request down with
        // it: the collection keeps its shape, the reason is in the log, and the plugin's routes see the old columns
        try { await updateCollection(db, existing, next); }
        catch (e) { logger.warn(`voidbase: ${plugin.manifest.name} could not bring its collection "${name}" up to date`, { error: e instanceof Error ? e.message : String(e) }); }
      }
      continue;
    }
    // A create that the instance refuses (a rule naming a collection that is not there, say) must not take every
    // request down with it: the plugin runs without that collection and says why, which is what the routes then
    // answer. Seen on the demo, 2026-09-11, when one bad rule made every request a 400.
    try { await createCollection(db, def); created.push(name); }
    catch (e) { logger.warn(`voidbase: ${plugin.manifest.name} could not create its collection "${name}"`, { error: e instanceof Error ? e.message : String(e) }); }
  }
  return created;
}
