// What a Void page's `.server.ts` is: a loader, run on the server and handed the visitor's own request. A
// navigation carries cookies and no Authorization header of the app's own, so `authOf(c)` -- the record voidbase
// authenticated this request as -- is not the question a loader asks. `sessionOf` is: it reads the auth cookie and
// has the generated app verify it exactly as it verifies every token.
import { defineHandler } from "void";
import { authOf, sessionOf } from "@voidbase-cloud/voidbase/adapter";

export const loader = defineHandler(async (c) => {
  const session = await sessionOf(c.req.raw);
  return {
    // who the page renders for
    id: session?.id ?? null,
    email: session?.getString("email") ?? null,
    collection: session?.collection().name ?? null,
    // and who the API made of the same request, so the two can be compared
    api: authOf(c)?.id ?? null,
  };
});
