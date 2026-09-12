/// <reference path="../../server/hooks/virtual.d.ts" />
// pb_hooks bundled at build time by hooks-plugin.ts (virtual module)
// the ambient declaration of the virtual module below, referenced so that a package outside this one — a plugin
// typed against the workerd condition — picks it up too, and not only this package's own tsconfig `include`.
export { files, hooks, hooksDir, modules } from "virtual:voidbase-hooks";
