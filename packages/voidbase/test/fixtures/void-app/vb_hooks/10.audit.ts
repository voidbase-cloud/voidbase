// An event hook limited to one collection: the trailing arguments are PocketBase's tags.
import { defineHook } from "@voidbase-cloud/voidbase/adapter";
import { state } from "@/server";

export default defineHook("onRecordsListRequest", async (e) => {
  state.lists++;
  await e.next();
}, "_superusers");
