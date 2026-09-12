import { defineHandler } from "void";
import { authOf, pb, requireAuth } from "@voidbase-cloud/voidbase/adapter";

// A route written the Void way that uses PocketBase's own API: the adapter hands it in, because code compiled
// into pb_hooks cannot import voidbase.
export const GET = defineHandler(async () => {
  const superusers = pb.$app.findCollectionByNameOrId("_superusers");
  const rows = await pb.$app.findRecordsByFilter("_superusers", "", "-created", 5, 0);
  return { collection: superusers.name, superusers: rows.length, error: pb.BadRequestError.name };
});

// requireAuth is the Void-shaped counterpart of $apis.requireAuth
export const POST = defineHandler(requireAuth("users"), async (c) => ({ id: authOf(c)?.id ?? null }));
