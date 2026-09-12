/// <reference path="../../server/hooks/virtual-migrations.d.ts" />
// the ambient declaration of the virtual module below, referenced so that a package outside this one — a plugin
// typed against the workerd condition — picks it up too, and not only this package's own tsconfig `include`.
export { migrations } from "virtual:voidbase-migrations";
