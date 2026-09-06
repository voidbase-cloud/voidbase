// Vite plugin: bundles a PocketBase `pb_hooks` directory as the virtual module "virtual:voidbase-hooks".
// Hook files are written against PocketBase's synchronous JSVM API; here I/O is async, so each file is
// transformed with the TypeScript compiler API: calls to known I/O methods get `await`, the functions that
// contain them become `async`, and the change propagates to callers (also across files via exported names).
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PLATFORM_MODULES = ["env", "log", "sse", "sockets", "hooks", "migrations", "photon"];
import ts from "typescript";
import type { Plugin } from "vite";

const VIRTUAL = "virtual:voidbase-hooks";
const RESOLVED = "\0" + VIRTUAL;
const VIRTUAL_MIGRATIONS = "virtual:voidbase-migrations";
const RESOLVED_MIGRATIONS = "\0" + VIRTUAL_MIGRATIONS;

// method names whose calls perform I/O in the voidbase runtime
const ASYNC_PROPS = new Set([
  "next", "submit", "save", "saveNoValidate", "delete", "send", "runInTransaction",
  "findRecordById", "findRecordsByFilter", "findFirstRecordByFilter", "findFirstRecordByData", "findAllRecords", "countRecords",
  "findAuthRecordByEmail", "findAuthRecordByToken", "expandRecord", "expandRecords",
  "fileFromURL", "fileFromBytes", "fileFromPath", "bindBody", "requestInfo",
  "importCollections",
]);

export const HOOK_GLOBALS = [
  "$app", "$apis", "$http", "$os", "$filesystem", "$security", "$mails", "$template", "$dbx",
  "routerAdd", "routerUse", "cronAdd", "cronRemove", "migrate",
  "Record", "Collection", "RecordUpsertForm", "MailerMessage", "DateTime", "RequestInfo",
  "Field", "TextField", "EditorField", "NumberField", "BoolField", "EmailField", "URLField", "DateField", "AutodateField", "SelectField", "FileField", "RelationField", "JSONField", "GeoPointField", "PasswordField",
  "ApiError", "NotFoundError", "BadRequestError", "ForbiddenError", "UnauthorizedError", "InternalServerError", "ValidationError",
  "__hooks", "require", "module", "exports", "console", "toString", "sleep", "arrayOf", "unmarshal",
];
const EVENT_HOOKS = ["Bootstrap", "Serve", "Terminate", "BackupCreate", "BackupRestore",
  "ModelValidate", "ModelCreate", "ModelCreateExecute", "ModelAfterCreateSuccess", "ModelAfterCreateError", "ModelUpdate", "ModelUpdateExecute", "ModelAfterUpdateSuccess", "ModelAfterUpdateError", "ModelDelete", "ModelDeleteExecute", "ModelAfterDeleteSuccess", "ModelAfterDeleteError",
  "RecordEnrich", "RecordValidate", "RecordCreate", "RecordCreateExecute", "RecordAfterCreateSuccess", "RecordAfterCreateError", "RecordUpdate", "RecordUpdateExecute", "RecordAfterUpdateSuccess", "RecordAfterUpdateError", "RecordDelete", "RecordDeleteExecute", "RecordAfterDeleteSuccess", "RecordAfterDeleteError",
  "CollectionValidate", "CollectionCreate", "CollectionCreateExecute", "CollectionAfterCreateSuccess", "CollectionAfterCreateError", "CollectionUpdate", "CollectionUpdateExecute", "CollectionAfterUpdateSuccess", "CollectionAfterUpdateError", "CollectionDelete", "CollectionDeleteExecute", "CollectionAfterDeleteSuccess", "CollectionAfterDeleteError",
  "MailerSend", "MailerRecordAuthAlertSend", "MailerRecordPasswordResetSend", "MailerRecordVerificationSend", "MailerRecordEmailChangeSend", "MailerRecordOTPSend",
  "RealtimeConnectRequest", "RealtimeMessageSend", "RealtimeSubscribeRequest",
  "SettingsListRequest", "SettingsUpdateRequest", "SettingsReload", "FileDownloadRequest", "FileTokenRequest",
  "RecordAuthRequest", "RecordAuthWithPasswordRequest", "RecordAuthRefreshRequest", "RecordRequestPasswordResetRequest", "RecordConfirmPasswordResetRequest", "RecordRequestVerificationRequest", "RecordConfirmVerificationRequest", "RecordRequestEmailChangeRequest", "RecordConfirmEmailChangeRequest", "RecordRequestOTPRequest", "RecordAuthWithOTPRequest",
  "RecordsListRequest", "RecordViewRequest", "RecordCreateRequest", "RecordUpdateRequest", "RecordDeleteRequest",
  "CollectionsListRequest", "CollectionViewRequest", "CollectionCreateRequest", "CollectionUpdateRequest", "CollectionDeleteRequest", "CollectionsImportRequest", "BatchRequest",
].map((n) => "on" + n);
export const ALL_GLOBALS = [...HOOK_GLOBALS, ...EVENT_HOOKS];

interface FileInfo { name: string; code: string; kind: "hook" | "module" | "file" }

function readDir(dir: string): FileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => {
    const code = readFileSync(join(dir, f), "utf8");
    const kind: FileInfo["kind"] = f.endsWith(".pb.js") ? "hook" : extname(f) === ".js" ? "module" : "file";
    return { name: f, code, kind };
  });
}

function calleeName(call: ts.CallExpression): { prop?: string; ident?: string } {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e)) return { prop: e.name.text };
  if (ts.isIdentifier(e)) return { ident: e.text };
  return {};
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function declaredName(fn: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

// Marks functions containing async calls; returns the set of named functions that became async.
function analyze(sf: ts.SourceFile, asyncNames: Set<string>, asyncFns: Set<ts.Node>): boolean {
  let changed = false;
  const visit = (node: ts.Node, enclosing: ts.FunctionLikeDeclaration[]) => {
    if (ts.isCallExpression(node)) {
      const { prop, ident } = calleeName(node);
      const hit = (prop && ASYNC_PROPS.has(prop)) || (ident && asyncNames.has(ident));
      if (hit) {
        const fn = enclosing[enclosing.length - 1];
        if (fn && !asyncFns.has(fn)) {
          asyncFns.add(fn);
          changed = true;
          const name = declaredName(fn);
          if (name && !asyncNames.has(name)) { asyncNames.add(name); changed = true; }
        }
      }
    }
    const next = isFn(node) ? [...enclosing, node] : enclosing;
    ts.forEachChild(node, (c) => visit(c, next));
  };
  visit(sf, []);
  return changed;
}

function transform(sf: ts.SourceFile, asyncNames: Set<string>, asyncFns: Set<ts.Node>): string {
  const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    const visit = (node: ts.Node): ts.Node => {
      const visited = ts.visitEachChild(node, visit, ctx);
      if (ts.isCallExpression(visited) && !(node.parent && ts.isAwaitExpression(node.parent))) {
        const { prop, ident } = calleeName(node as ts.CallExpression);
        if ((prop && ASYNC_PROPS.has(prop)) || (ident && asyncNames.has(ident))) {
          return ts.factory.createParenthesizedExpression(ts.factory.createAwaitExpression(visited as ts.Expression));
        }
      }
      if (isFn(node) && asyncFns.has(node)) {
        const f = ts.factory;
        const mods = [...(ts.canHaveModifiers(visited) ? ts.getModifiers(visited) ?? [] : [])];
        if (!mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) mods.unshift(f.createToken(ts.SyntaxKind.AsyncKeyword));
        if (ts.isFunctionDeclaration(visited)) return f.updateFunctionDeclaration(visited, mods, visited.asteriskToken, visited.name, visited.typeParameters, visited.parameters, visited.type, visited.body);
        if (ts.isFunctionExpression(visited)) return f.updateFunctionExpression(visited, mods, visited.asteriskToken, visited.name, visited.typeParameters, visited.parameters, visited.type, visited.body);
        if (ts.isArrowFunction(visited)) return f.updateArrowFunction(visited, mods, visited.typeParameters, visited.parameters, visited.type, visited.equalsGreaterThanToken, visited.body);
        if (ts.isMethodDeclaration(visited)) return f.updateMethodDeclaration(visited, mods, visited.asteriskToken, visited.name, visited.questionToken, visited.typeParameters, visited.parameters, visited.type, visited.body);
      }
      return visited;
    };
    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };
  const result = ts.transform(sf, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const out = printer.printFile(result.transformed[0] as ts.SourceFile);
  result.dispose();
  return out;
}

export function compileHooksDir(dir: string): string {
  const files = readDir(dir);
  const sources = new Map<string, ts.SourceFile>();
  for (const f of files) if (f.kind !== "file") sources.set(f.name, ts.createSourceFile(f.name, f.code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS));
  const asyncNames = new Set<string>();
  const asyncFns = new Set<ts.Node>();
  for (let i = 0; i < 20; i++) {
    let changed = false;
    for (const sf of sources.values()) changed = analyze(sf, asyncNames, asyncFns) || changed;
    if (!changed) break;
  }
  const destructure = `const { ${ALL_GLOBALS.join(", ")} } = __g;`;
  const hooks: string[] = [];
  const modules: string[] = [];
  const raw: string[] = [];
  for (const f of files) {
    if (f.kind === "file") { raw.push(`${JSON.stringify(f.name)}: ${JSON.stringify(f.code)}`); continue; }
    const body = transform(sources.get(f.name)!, asyncNames, asyncFns);
    if (f.kind === "hook") hooks.push(`{ name: ${JSON.stringify(f.name)}, run: async function (__g) { ${destructure}\n${body}\n} }`);
    else modules.push(`${JSON.stringify(basename(f.name, ".js"))}: async function (__g) { ${destructure}\n${body}\nreturn module.exports; }`);
  }
  return `export const hooksDir = ${JSON.stringify(dir)};\nexport const asyncNames = ${JSON.stringify([...asyncNames])};\nexport const hooks = [${hooks.join(",\n")}];\nexport const modules = { ${modules.join(",\n")} };\nexport const files = { ${raw.join(",\n")} };\n`;
}

// pb_migrations/*.js: each file calls migrate(up, down); the same await insertion applies (app.importCollections,
// app.save, app.delete ... are I/O here), so `up` becomes async and the runner can await it.
// The cron expressions registered by the hooks (cronAdd(id, expr, fn)) are known at build time: they become the
// Worker's cron triggers, so an app without cron hooks needs no every-minute trigger. PocketBase macros are expanded.
const CRON_MACROS: Record<string, string> = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };
export function extractCronExpressions(dir: string): string[] {
  const out = new Set<string>();
  for (const f of readDir(dir)) {
    if (f.kind === "file") continue;
    for (const m of f.code.matchAll(/cronAdd\s*\(\s*["'`][^"'`]*["'`]\s*,\s*["'`]([^"'`]+)["'`]/g)) out.add(CRON_MACROS[m[1]!.trim()] ?? m[1]!.trim());
  }
  return [...out];
}
// Cloudflare allows 5 triggers per Worker: the hook expressions (plus an hourly tick that runs PocketBase's
// maintenance and a backups cron configured in settings) or, when there are too many, every minute.
export function cronTriggers(dir: string): string[] {
  const fromHooks = extractCronExpressions(dir);
  return fromHooks.length > 4 ? ["* * * * *"] : [...new Set(["0 * * * *", ...fromHooks])];
}

export function compileMigrationsDir(dir: string): string {
  const files = readDir(dir).filter((f) => f.kind !== "file");
  const sources = new Map<string, ts.SourceFile>();
  for (const f of files) sources.set(f.name, ts.createSourceFile(f.name, f.code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS));
  const asyncNames = new Set<string>();
  const asyncFns = new Set<ts.Node>();
  for (let i = 0; i < 20; i++) {
    let changed = false;
    for (const sf of sources.values()) changed = analyze(sf, asyncNames, asyncFns) || changed;
    if (!changed) break;
  }
  const destructure = `const { ${ALL_GLOBALS.join(", ")} } = __g;`;
  const out = files.sort((a, b) => a.name.localeCompare(b.name)).map((f) =>
    `{ name: ${JSON.stringify(f.name)}, run: async function (__g) { ${destructure}\n${transform(sources.get(f.name)!, asyncNames, asyncFns)}\n} }`);
  return `export const migrationsDir = ${JSON.stringify(dir)};\nexport const migrations = [${out.join(",\n")}];\n`;
}

/** Copies index.html to 404.html (and _/index.html to _/404.html) so Cloudflare's 404-page handling serves the SPA shells. */
export function writeNotFoundShells(dir: string): string[] {
  const written: string[] = [];
  for (const sub of ["", "_/"]) {
    const index = join(dir, sub, "index.html"); const notFound = join(dir, sub, "404.html");
    if (existsSync(index) && !existsSync(notFound)) { copyFileSync(index, notFound); written.push(`${sub}404.html`); }
  }
  return written;
}

export function pbHooksPlugin(options: { dir?: string; migrationsDir?: string; hubEntry?: string } = {}): Plugin {
  const dir = resolve(options.dir ?? process.env.VOIDBASE_HOOKS_DIR ?? "pb_hooks");
  const migrationsDir = resolve(options.migrationsDir ?? process.env.VOIDBASE_MIGRATIONS_DIR ?? "pb_migrations");
  // hubEntry: the module exporting VoidbaseHub (src/server/hub.ts). Void generates the Worker entry (.void/entry.ts)
  // and exports only its own classes, so the instance's Durable Object class is appended to that entry at bundle time;
  // wrangler.jsonc declares the binding (HUB) and the new_sqlite_classes migration.
  const hubEntry = options.hubEntry ? resolve(options.hubEntry) : "";
  const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
  let clientOut = "";
  return {
    name: "voidbase-pb-hooks",
    // the Workers build takes the workers flavour of every #platform module (package.json "imports" covers Bun/Node)
    config() { return { resolve: { alias: PLATFORM_MODULES.map((n) => ({ find: `#platform/${n}`, replacement: resolve(here, "src/platform/workers", `${n}.ts`) })) } }; },
    configResolved(config) { clientOut = resolve(config.root, config.environments?.client?.build?.outDir ?? config.build.outDir); },
    // Asset-first on Cloudflare: the asset layer answers every request outside /api, so the Worker is never invoked
    // for static files. PocketBase's index fallback for deep links is expressed as Cloudflare's `not_found_handling:
    // "404-page"` (void.json routing.notFound): the nearest 404.html is served with status 404, so the SPA shell and the
    // panel's index are copied to 404.html at build time. Unknown /api paths keep their JSON 404 (the binding returns a
    // 404 for them, which Void's entry only swaps for the HTML page on browser navigations).
    closeBundle() { writeNotFoundShells(clientOut); },
    transform(code, id) {
      if (hubEntry && id.replace(/\\/g, "/").endsWith("/.void/entry.ts")) return { code: `${code}\nexport { VoidbaseHub } from ${JSON.stringify(hubEntry)};\n`, map: null };
      return null;
    },
    resolveId(id) { return id === VIRTUAL ? RESOLVED : id === VIRTUAL_MIGRATIONS ? RESOLVED_MIGRATIONS : null; },
    load(id) {
      if (id === RESOLVED) {
        if (existsSync(dir)) for (const f of readdirSync(dir)) this.addWatchFile(join(dir, f));
        return compileHooksDir(dir);
      }
      if (id === RESOLVED_MIGRATIONS) {
        if (existsSync(migrationsDir)) for (const f of readdirSync(migrationsDir)) this.addWatchFile(join(migrationsDir, f));
        return compileMigrationsDir(migrationsDir);
      }
      return null;
    },
  };
}
