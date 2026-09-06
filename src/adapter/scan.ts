// Reads a Void app's file conventions (void/docs/reference/structure.md) into a manifest. The scan is pure
// filesystem plus a TypeScript parse for the exported names, so it never imports the app's own code: the same
// function runs inside the Vite plugin, in `voidbase adapt` and in tests without booting the app.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

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
export interface VoidQueue extends VoidModule {
  /** Void derives the producer binding from the file name: queues/send-mail.ts -> QUEUE_SEND_MAIL */
  binding: string;
}
export interface VoidMigration { file: string; name: string }

/** paths voidbase serves itself; an app route under one of these never reaches the app (PocketBase answers first) */
export const RESERVED_PREFIXES = ["/api/backups", "/api/batch", "/api/collections", "/api/crons", "/api/files", "/api/health", "/api/logs", "/api/realtime", "/api/settings", "/_/"];

export interface VoidManifest {
  root: string;
  /** static: nothing to run, the build is just files under pb_public. server: routes/middleware/crons/queues exist. */
  mode: "static" | "server";
  routes: VoidRoute[];
  middleware: VoidModule[];
  crons: VoidModule[];
  queues: VoidQueue[];
  migrations: VoidMigration[];
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

  const middleware = modules("middleware"); // numeric prefixes order them; walk() already sorts by name
  const crons = modules("crons");
  const queues: VoidQueue[] = modules("queues").map((q) => ({ ...q, binding: `QUEUE_${q.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}` }));

  const migrationsDir = join(root, "db", "migrations");
  const migrations: VoidMigration[] = isDir(migrationsDir)
    ? readdirSync(migrationsDir).sort().filter((f) => f.endsWith(".sql")).map((f) => ({ file: `db/migrations/${f}`, name: basename(f, ".sql") }))
    : [];

  const unsupported: { what: string; why: string }[] = [];
  if (isDir(join(root, "pages"))) unsupported.push({ what: "pages/", why: "server-rendered pages need Void's render pipeline; prerender them (they land in pb_public) or keep them in a separate Void deploy" });
  if (walk(join(root, "routes")).some((f) => f.endsWith(".ws.ts"))) unsupported.push({ what: "routes/**/*.ws.ts", why: "document WebSockets are Durable Objects; voidbase's realtime hub owns that binding" });
  if (grepImports(root, "void/kv")) unsupported.push({ what: "void/kv", why: "voidbase binds D1 and R2 only; keep key-value data in a collection" });
  if (grepImports(root, "void/isr")) unsupported.push({ what: "void/isr", why: "ISR caches through the Void platform's dispatch worker, which a voidbase app does not have" });

  const collisions = routes.filter((r) => RESERVED_PREFIXES.some((p) => r.url === p || r.url.startsWith(p + "/"))).map((r) => r.url);
  const mode = routes.length || middleware.length || crons.length || queues.length ? "server" : "static";
  return { root, mode, routes, middleware, crons, queues, migrations, unsupported, collisions };
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
