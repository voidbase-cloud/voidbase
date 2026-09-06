/// <reference path="../.voidbase/pb_data/types.d.ts" />
// a PocketBase JS hook, copied into the generated app untouched
routerAdd("GET", "/api/from-hook", (e) => e.json(200, { hook: true }));
