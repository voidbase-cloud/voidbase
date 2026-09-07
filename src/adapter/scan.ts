// Reads a Void app's file conventions (void/docs/reference/structure.md) into a manifest. The scan is pure
// filesystem plus a TypeScript parse for the exported names, so it never imports the app's own code: the same
// function runs inside the Vite plugin, in `voidbase adapt` and in tests without booting the app.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { EVENT_HOOKS } from "../../hooks-plugin";

const CODE = new Set([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]);
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"] as const;

export interface VoidRoute {
  /** source file, relative to the app root */
  file: string;
  /** URL the file maps to, in Void's own syntax: /api/users/:id, /files/* */
  url: string;
  /** the same path in the hook router's dialect (identical today; kept explicit so one can move) */
  hookPath: string;
  /** exported HTTP methods, uppercase */
  methods: string[];
  /** :param names in order, and the trailing [...name] when the route is a catch-all */
  params: string[];
  splat?: string;
}
export interface VoidModule { file: string; name: string }
/** A `vb_hooks/` file: one PocketBase hook, registered once. `hook` is `routerUse` or an `on*` event name. */
export interface VoidHook extends VoidModule { hook: string }
export interface VoidQueue extends VoidModule {
  /** Void derives the producer binding from the file name: queues/send-mail.ts -> QUEUE_SEND_MAIL */
  binding: string;
}
export interface VoidMigration { file: string; name: string }

/** Where a Void app keeps what belongs to voidbase rather than to Void. All of it is optional. */
export interface VoidbaseExtras {
  /** vb_migrations/: PocketBase JS migrations, copied in beside the ones generated from db/migrations */
  migrationsDir?: string;
}
/** The two directories this adapter adds to a Void app, both named for the voidbase thing they are, both sitting
 * at the project root beside Void's own `db/`. Everything else is Void's and means what Void means by it:
 * `routes/`, `middleware/`, `crons/` and `queues/` are the server code, compiled into the generated app's
 * pb_hooks, and `src/` is library code they import. */
export const MIGRATIONS_DIR = "vb_migrations";
export const HOOKS_DIR = "vb_hooks";

/** PocketBase's global request middleware: what Void's own `middleware/` becomes. */
export const REQUEST_HOOK = "routerUse";
/** every name a `vb_hooks/` file may attach itself to */
export const HOOK_NAMES: readonly string[] = [REQUEST_HOOK, ...EVENT_HOOKS];
/** the known hooks whose names are closest to `name`, for the build error */
function nearestHooks(name: string): string[] {
  const needle = name.toLowerCase();
  return HOOK_NAMES.filter((h) => { const k = h.toLowerCase(); return k.includes(needle) || needle.includes(k); }).slice(0, 4);
}

/** paths voidbase serves itself; an app route under one of these never reaches the app (PocketBase answers first) */
export const RESERVED_PREFIXES = ["/api/backups", "/api/batch", "/api/collections", "/api/crons", "/api/files", "/api/health", "/api/logs", "/api/realtime", "/api/settings", "/api/webauthn", "/_/"];

export interface VoidManifest {
  root: string;
  /** static: nothing to run, the build is just files under pb_public. server: routes/middleware/crons/queues exist. */
  mode: "static" | "server";
  routes: VoidRoute[];
  middleware: VoidModule[];
  /** vb_hooks/: one PocketBase hook per file, registered once when the app mounts */
  hooks: VoidHook[];
  crons: VoidModule[];
  queues: VoidQueue[];
  migrations: VoidMigration[];
  /** the app's own voidbase side (vb_migrations/) */
  extras: VoidbaseExtras;
  /** directories the app has that this adapter cannot carry, with the reason */
  unsupported: { what: string; why: string }[];
  /** app routes shadowed by voidbase's own API */
  collisions: string[];
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Every code file under dir, depth first, skipping `_`-prefixed files and directories (Void ignores those). */
function walk(dir: string, base = dir): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir).sort().flatMap((entry) => {
    if (entry.startsWith("_")) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full, base);
    return CODE.has(extname(entry)) ? [relative(base, full)] : [];
  });
}

/** `debug.dev.ts` builds in development only, `metrics.prod.ts` in production only; everything else in both. */
function envSuffix(file: string): "dev" | "prod" | null {
  const stem = basename(file, extname(file));
  if (stem.endsWith(".dev")) return "dev";
  if (stem.endsWith(".prod")) return "prod";
  return null;
}
/** the file name without its extension and without a `.dev` / `.prod` suffix (`[...path].ts` keeps its dots) */
function stemOf(file: string): string {
  return basename(file, extname(file)).replace(/\.(dev|prod)$/, "");
}

/**
 * The PocketBase hook a `vb_hooks/` file attaches to, read from the source without evaluating it:
 *
 *     export default defineHook("onRecordCreate", handler, "posts")
 *
 * `export const hook = "onRecordCreate"` names it too, for a handler that comes from somewhere else. Returns null
 * when the file names no hook, which is a build error: there is nowhere to register it.
 */
export function hookName(code: string, file = "m.ts"): string | null {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const literal = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  let fromCall: string | null = null;
  let fromConst: string | null = null;

  const callName = (expr: ts.Expression): string | null => {
    if (!ts.isCallExpression(expr)) return null;
    const callee = ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name.text : ts.isIdentifier(expr.expression) ? expr.expression.text : "";
    return callee === "defineHook" ? literal(expr.arguments[0]) : null;
  };

  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && !st.isExportEquals) fromCall ??= callName(st.expression);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (d.name.text === "hook") fromConst ??= literal(d.initializer);
        // `const mw = defineHook(...); export default mw;` is the same declaration, read through
        fromCall ??= callName(d.initializer);
      }
    }
  }
  return fromCall ?? fromConst;
}

/** The names a module exports, without evaluating it (`export const GET`, `export { GET }`, `export default`). */
export function exportedNames(code: string, file = "m.ts"): Set<string> {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const exported = (node: ts.Node) => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && exported(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && exported(st) && st.name) names.add(st.name.text);
    if (ts.isExportAssignment(st)) names.add("default");
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) names.add(el.name.text);
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) names.add("default");
  }
  return names;
}

/** routes/api/users/[id].ts -> { url: "/api/users/:id", params: ["id"] }; (group)/ is stripped, index is the directory. */
export function routeUrl(file: string): { url: string; params: string[]; splat?: string } {
  const params: string[] = [];
  let splat: string | undefined;
  const stem = stemOf(file);
  const segments = [...file.split(/[\\/]/).slice(0, -1), stem]
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")))
    .filter((s, i, all) => !(s === "index" && i === all.length - 1));
  const path = segments.map((seg) => {
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg);
    if (catchAll) { splat = catchAll[1]!; return "*"; }
    const param = /^\[(.+)\]$/.exec(seg);
    if (param) { params.push(param[1]!); return `:${param[1]}`; }
    return seg;
  }).join("/");
  return { url: "/" + path, params, splat };
}

export interface ScanOptions { root?: string; dev?: boolean }

export function scanVoidApp(opts: ScanOptions = {}): VoidManifest {
  const root = resolve(opts.root ?? ".");
  const dev = !!opts.dev;
  const rel = (dir: string, file: string) => `${dir}/${file.split("\\").join("/")}`;

  const routes: VoidRoute[] = [];
  for (const file of walk(join(root, "routes"))) {
    const suffix = envSuffix(file);
    if (suffix && (suffix === "dev") !== dev) continue;
    const methods = [...exportedNames(readFileSync(join(root, "routes", file), "utf8"), file)].filter((n) => (HTTP_METHODS as readonly string[]).includes(n));
    if (!methods.length) continue; // a file in routes/ that exports no verb is not a route
    const { url, params, splat } = routeUrl(file);
    routes.push({ file: rel("routes", file), url, hookPath: url, methods, params, ...(splat ? { splat } : {}) });
  }
  // most specific first, so /api/users/me is registered before /api/users/:id and /files/*
  routes.sort((a, b) => score(b.url) - score(a.url) || a.url.localeCompare(b.url));

  const modules = (dir: string): VoidModule[] =>
    walk(join(root, dir)).map((file) => ({ file: rel(dir, file), name: stemOf(file) }));

  // Void's own middleware/: every request, in file order, which is PocketBase's routerUse. A file that turns out to
  // be a PocketBase hook belongs next door, and says so rather than being called with the wrong arguments.
  const middleware = modules("middleware").map((m) => {
    const named = hookName(readFileSync(join(root, m.file), "utf8"), m.file);
    if (named) throw new Error(`voidbase: ${m.file} is a PocketBase hook ("${named}"), not a Void middleware. Move it to ${HOOKS_DIR}/, where one file is one hook.\n  middleware/ is Void's: defineMiddleware((c, next) => ...), every request, no hook to name.`);
    return m;
  });

  // vb_hooks/: one file, one PocketBase hook, registered once when the app mounts. Numeric prefixes order them,
  // and walk() already sorts by name.
  const hooks: VoidHook[] = modules(HOOKS_DIR).map((m) => {
    const hook = hookName(readFileSync(join(root, m.file), "utf8"), m.file);
    if (!hook) throw new Error(`voidbase: ${m.file} is not attached to a hook, so there is nowhere to register it. Name the hook it is:\n  export default defineHook("onRecordCreate", handler, "posts")\n  A plain Void middleware, running on every request, belongs in middleware/ instead.`);
    if (!HOOK_NAMES.includes(hook)) {
      const near = nearestHooks(hook);
      throw new Error(`voidbase: ${m.file} names "${hook}", which is not one of PocketBase's hooks.${near.length ? ` Did you mean ${near.join(", ")}?` : ` Use "${REQUEST_HOOK}" for a request middleware, or one of PocketBase's on* event hooks.`}`);
    }
    return { ...m, hook };
  });
  const crons = modules("crons");
  const queues: VoidQueue[] = modules("queues").map((q) => ({ ...q, binding: `QUEUE_${q.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}` }));

  const migrationsDir = join(root, "db", "migrations");
  const migrations: VoidMigration[] = isDir(migrationsDir)
    ? readdirSync(migrationsDir).sort().filter((f) => f.endsWith(".sql")).map((f) => ({ file: `db/migrations/${f}`, name: basename(f, ".sql") }))
    : [];

  // `output: "static"` prerenders every page to HTML at build time, which is exactly what pb_public wants; pages
  // that still need rendering per request have no runtime here, so say so.
  let voidOutput = "server";
  try { voidOutput = (JSON.parse(readFileSync(join(root, "void.json"), "utf8")) as { output?: string }).output ?? "server"; } catch { /* no void.json */ }
  const unsupported: { what: string; why: string }[] = [];
  if (isDir(join(root, "pages")) && voidOutput !== "static") unsupported.push({ what: "pages/", why: 'server-rendered pages need Void\'s render pipeline; set "output": "static" in void.json to prerender them into pb_public' });
  if (walk(join(root, "routes")).some((f) => f.endsWith(".ws.ts"))) unsupported.push({ what: "routes/**/*.ws.ts", why: "document WebSockets are Durable Objects; voidbase's realtime hub owns that binding" });
  if (grepImports(root, "void/kv")) unsupported.push({ what: "void/kv", why: "voidbase binds D1 and R2 only; keep key-value data in a collection" });
  if (grepImports(root, "void/isr")) unsupported.push({ what: "void/isr", why: "ISR caches through the Void platform's dispatch worker, which a voidbase app does not have" });

  const extras: VoidbaseExtras = {
    migrationsDir: isDir(join(root, MIGRATIONS_DIR)) ? MIGRATIONS_DIR : undefined,
  };

  const collisions = routes.filter((r) => RESERVED_PREFIXES.some((p) => r.url === p || r.url.startsWith(p + "/"))).map((r) => r.url);
  // "static" means nothing has to run: no Void server code and no voidbase extensions of the app's own
  const mode = routes.length || middleware.length || hooks.length || crons.length || queues.length ? "server" : "static";
  return { root, mode, routes, middleware, hooks, crons, queues, migrations, extras, unsupported, collisions };
}

/** literal segments beat params beat wildcards, longer paths beat shorter (the hook router scores the same way) */
function score(path: string): number {
  const segs = path.split("/").filter(Boolean);
  return (path.includes("*") ? 0 : 1000) + segs.filter((s) => !s.startsWith(":") && s !== "*").length * 10 + segs.length;
}

/** cheap source grep for a bare-specifier import, used only to report what the adapter cannot carry */
function grepImports(root: string, specifier: string): boolean {
  const needle = new RegExp(`from\\s+["']${specifier.replace("/", "\\/")}["']`);
  for (const dir of ["routes", "middleware", "crons", "queues", "src", "db"]) {
    for (const file of walk(join(root, dir))) {
      if (needle.test(readFileSync(join(root, dir, file), "utf8"))) return true;
    }
  }
  return false;
}
