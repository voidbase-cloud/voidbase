// The collections a plugin owns, created by the plugin itself.
//
// A manifest names the collections a plugin owns so that two plugins claiming one name collide at install rather
// than at boot. Owning one also means creating it: the plugin asks for it here, at bootstrap (kernel onBootstrap),
// with the same definition the collections API takes, and it is created through the same service the panel uses,
// table and all, once, when it is missing. A collection the manifest does not name is refused before anything is
// touched, because a plugin creating what it did not declare is exactly what the ownership rule exists to stop.
// The auth plugin's five collections are the exception that predates this: they are system tables voidbase's own
// schema creates, and the manifest owns them so nothing else can.
import { findCollection } from "../collections/model";
import { createCollection } from "../collections/service";
import type { Plugin } from "./manifest";

/** create the owned collections that are missing; returns the names created */
export async function ensureCollections(plugin: Plugin, db: D1Database, definitions: Record<string, unknown>[]): Promise<string[]> {
  const owned = new Set(plugin.manifest.collections ?? []);
  for (const def of definitions) {
    const name = String(def.name ?? "");
    if (!owned.has(name)) throw new Error(`voidbase: ${plugin.manifest.name} creates the collection "${name}" without owning it; list it under "collections" in the manifest, which is what lets the loader refuse a second owner at install`);
  }
  const created: string[] = [];
  for (const def of definitions) {
    const name = String(def.name);
    if (await findCollection(db, name)) continue;
    await createCollection(db, def);
    created.push(name);
  }
  return created;
}
