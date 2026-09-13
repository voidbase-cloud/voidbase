// The Worker build's name for voidbase: a project entry file imports `@voidbase-cloud/voidbase` by name (D2's index.ts),
// and inside the Worker that has to be the Worker's app API, not the Bun CLI. Vite resolves a bare package name before a
// normal plugin's resolveId runs, so the mapping is an alias, matched exactly; found by deploying an npm project whose
// Worker answered 500 with `No such module "assets/bun:sqlite"`.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pbHooksPlugin } from "../../hooks-plugin";

type Alias = { find: string | RegExp; replacement: string };
const aliases = (): Alias[] => ((pbHooksPlugin({}) as unknown as { config(): { resolve: { alias: Alias[] } } }).config().resolve.alias);
const matches = (a: Alias, id: string) => (typeof a.find === "string" ? id === a.find || id.startsWith(`${a.find}/`) : a.find.test(id));

describe("the Worker build's name for voidbase", () => {
  test("the package's own name is the Worker's app API", () => {
    const hit = aliases().find((a) => matches(a, "@voidbase-cloud/voidbase"));
    expect(hit?.replacement).toBe(resolve(import.meta.dir, "../../src/server/library.ts"));
  });
  test("only the bare name: the published entries keep resolving through the package's exports", () => {
    const bare = aliases().find((a) => matches(a, "@voidbase-cloud/voidbase"));
    for (const id of ["@voidbase-cloud/voidbase/app", "@voidbase-cloud/voidbase/kernel", "@voidbase-cloud/voidbase/plugins/collections"]) expect(bare && matches(bare, id)).toBe(false);
  });
});
