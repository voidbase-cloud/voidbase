// pb_secrets/: the app's configuration, declared where the tooling can read it and valued where git cannot see it.
//
//   pb_secrets/main.ts        the declaration, committed: `export default defineSecrets({ NAME: string().secret(), ... })`
//   pb_secrets/secrets.json   the local values, git-ignored: `{ "NAME": "value", ... }`. On a dev machine only.
//
// The declaration (src/env/define.ts) gives every key a validator and an access tier: `secret` (the Worker's
// encrypted secrets), `server` (plain Worker vars) or `public` (Worker vars the client build inlines too).
// `voidbase serve` parses the local values and the shell through the validators and puts the result into the
// process environment, so `$os.getenv("NAME")` and the app's own code see what they will see on Cloudflare.
// `voidbase deploy` stores secrets the Worker lacks as its secrets and every server/public value as its vars, and
// refuses to deploy while a value is invalid or a required one is missing everywhere: a CI checkout has no
// secrets.json, and that is the point -- the secrets are pushed once from a machine that has them (`voidbase
// secrets push`), the plain values come from the deploy's environment or the declared defaults, and the pipeline
// needs nothing but the deploy token.
//
// Cloudflare's account-level Secrets Store is deliberately not used: one store is shared by every Worker of the
// account, and its bindings are read asynchronously, which `$os.getenv` is not.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { CfApi } from "../cloud/rest";
import { isDefinition, type Access, type Definition, type Evaluation, type KeyInfo, type Spec } from "../env/define";

export const SECRETS_DIR = "pb_secrets";
export const DECLARATION_FILES = ["main.ts", "main.js", "main.mjs"];
export const VALUES_FILE = "secrets.json";
const NAME = /^[A-Z][A-Z0-9_]*$/;

// ---- the declaration, read from the source without running it (what the adapter's scan needs) -------------------

export interface SecretsDeclaration {
  /** the file the names came from */
  file: string;
  /** declared names, in file order */
  names: string[];
  /** the tier of each name */
  access: Record<string, Access>;
  /** what each one is, when the declaration says */
  descriptions: Record<string, string>;
}

/**
 * The names, tiers and descriptions a declaration file declares, without evaluating it:
 *
 *     export default defineSecrets({
 *       SMTP_PASSWORD: string().secret(),                       -> secret
 *       ADMIN_EMAILS: describe(string().default(""), "who..."), -> server, described
 *       API_URL: url().optional().public(),                     -> public
 *       OTHER: secret(zodSchema, "..."),                        -> secret, described
 *     })
 */
export function parseSecretsDeclaration(code: string, file = "pb_secrets/main.ts"): SecretsDeclaration {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const names: string[] = []; const access: Record<string, Access> = {}; const descriptions: Record<string, string> = {};
  const literal = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  const calleeName = (c: ts.CallExpression) => (ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : "");
  // the tier and description of one value expression: wrappers first, then Void's .secret()/.public() chain
  const classify = (expr: ts.Expression): { access: Access; description: string | null } => {
    let description: string | null = null; let tier: Access | null = null;
    let node: ts.Expression = expr;
    while (ts.isCallExpression(node)) {
      const fn = calleeName(node);
      if (fn === "describe") { description ??= literal(node.arguments[1]); node = node.arguments[0] ?? node; if (node === expr) break; continue; }
      if (fn === "secret" || fn === "server" || fn === "pub" || fn === "public" || fn === "local") {
        if (ts.isIdentifier(node.expression)) { tier ??= fn === "pub" ? "public" : (fn as Access); description ??= literal(node.arguments[1]); node = node.arguments[0] ?? node; if (!node || node === expr) break; continue; }
        tier ??= fn === "secret" ? "secret" : "public"; // Void's .secret() / .public() on a validator chain
      }
      node = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression;
      if (!ts.isCallExpression(node)) break;
    }
    return { access: tier ?? "server", description };
  };
  const add = (name: string | null, expr: ts.Expression | undefined) => {
    if (!name) return;
    if (!NAME.test(name)) throw new Error(`voidbase: ${file}: "${name}" is not a configuration name (UPPER_CASE, letters, digits and underscores, like an environment variable)`);
    const c = expr ? classify(expr) : { access: "server" as Access, description: null };
    if (!names.includes(name)) names.push(name);
    access[name] = c.access; if (c.description) descriptions[name] = c.description;
  };
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calleeName(node) === "defineSecrets") {
      found = true;
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error(`voidbase: ${file}: defineSecrets() takes an object literal: { NAME: string().secret(), ... }`);
      for (const p of arg.properties) {
        if (ts.isPropertyAssignment(p)) add(ts.isStringLiteralLike(p.name) || ts.isIdentifier(p.name) ? p.name.text : null, p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) add(p.name.text, undefined);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`voidbase: ${file} does not call defineSecrets(): export default defineSecrets({ ... })`);
  return { file, names, access, descriptions };
}

/** The declaration file of a pb_secrets/ directory, or null. */
export function declarationFile(dir = SECRETS_DIR): string | null {
  return DECLARATION_FILES.map((f) => join(resolve(dir), f)).find((f) => existsSync(f)) ?? null;
}

/** The declaration of a pb_secrets/ directory, read statically, or null when there is none. */
export function readSecretsDeclaration(dir = SECRETS_DIR): SecretsDeclaration | null {
  const file = declarationFile(dir);
  return file ? parseSecretsDeclaration(readFileSync(file, "utf8"), file) : null;
}

// ---- the declaration, imported (what serve, deploy and the build need: the validators themselves) ---------------

/** Imports the declaration module and returns its definition, or null when the directory has none. */
export async function loadDefinition(dir = SECRETS_DIR): Promise<{ file: string; definition: Definition<Spec> } | null> {
  const file = declarationFile(dir);
  if (!file) return null;
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (!isDefinition(mod.default)) throw new Error(`voidbase: ${file} must export defineSecrets({ ... }) as its default export`);
  return { file, definition: mod.default };
}

/** The local values of a pb_secrets/ directory (`secrets.json`), or null when the file is absent. Every value is a string. */
export function readSecretsValues(dir = SECRETS_DIR): Record<string, string> | null {
  const file = join(resolve(dir), VALUES_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`voidbase: ${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`voidbase: ${file} must be an object: { "NAME": "value" }`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!NAME.test(k)) throw new Error(`voidbase: ${file}: "${k}" is not a configuration name (UPPER_CASE, letters, digits and underscores)`);
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

export interface SecretsState {
  dir: string;
  /** the declaration file, or null when there is none */
  file: string | null;
  definition: Definition<Spec> | null;
  /** what each key is: tier, description, default */
  info: KeyInfo[];
  /** the local values, or null when there is no secrets.json */
  values: Record<string, string> | null;
  /** declared names with a local value */
  provided: string[];
  /** declared names without a local value */
  unprovided: string[];
  /** local values that no declaration names */
  undeclared: string[];
}

/** What a pb_secrets/ directory declares and holds locally, and how the two compare. */
export async function secretsState(dir = SECRETS_DIR): Promise<SecretsState> {
  const loaded = await loadDefinition(dir);
  const values = readSecretsValues(dir);
  if (!loaded && values && Object.keys(values).length) {
    throw new Error(`voidbase: ${join(resolve(dir), VALUES_FILE)} holds ${Object.keys(values).length} value(s) but nothing declares them. Name them in ${join(dir, "main.ts")}:\n  export default defineSecrets({ ${Object.keys(values).map((k) => `${k}: string().secret()`).join(", ")} })`);
  }
  const names = loaded?.definition.names ?? [];
  const have = new Set(Object.keys(values ?? {}));
  return {
    dir: resolve(dir), file: loaded?.file ?? null, definition: loaded?.definition ?? null, info: loaded ? await loaded.definition.info() : [], values,
    provided: names.filter((n) => have.has(n)),
    unprovided: names.filter((n) => !have.has(n)),
    undeclared: [...have].filter((n) => !names.includes(n)),
  };
}

export interface LoadedSecrets {
  state: SecretsState;
  /** the parse of the local values under the environment (the environment wins) */
  evaluation: Evaluation<Spec> | null;
  /** names this call put into the environment (from the file or a default) */
  loaded: string[];
  /** declared names with no value anywhere and no default */
  missing: string[];
  /** declared names whose value was refused, by name and reason */
  invalid: { name: string; message: string }[];
  /** local values that no declaration names */
  undeclared: string[];
}

/**
 * Parses the local values and the environment through the declaration and puts every stored value (defaults
 * included) into the environment, never over a value that is already there. Nothing throws for a missing or
 * refused value: the caller decides (serve warns, deploy stops).
 */
export async function loadSecrets(dir = SECRETS_DIR, into: Record<string, string | undefined> = process.env): Promise<LoadedSecrets> {
  const state = await secretsState(dir);
  if (!state.definition) return { state, evaluation: null, loaded: [], missing: [], invalid: [], undeclared: state.undeclared };
  const raw: Record<string, unknown> = { ...(state.values ?? {}) };
  for (const n of state.definition.names) if (into[n] !== undefined && into[n] !== "") raw[n] = into[n];
  const evaluation = await state.definition.evaluate(raw);
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(evaluation.stored)) if (into[k] === undefined || into[k] === "") { into[k] = v; loaded.push(k); }
  return { state, evaluation, loaded, missing: evaluation.missing, invalid: evaluation.invalid, undeclared: state.undeclared };
}

// ---- the Worker's secrets, through the Workers API (what `wrangler secret put` calls) -----------------------------

/** The names of the secrets a Worker has; an empty list when the Worker does not exist yet. */
export async function workerSecretNames(api: CfApi, account: string, worker: string): Promise<string[]> {
  // 10007: no such script yet (the first deploy creates it); CfApi tolerates error codes, not HTTP statuses
  const res = await api.json<{ name: string; type: string }[]>("GET", `/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/secrets`, undefined, [10007]);
  return (res.result ?? []).map((s) => s.name);
}

/** Stores secrets on a Worker, one call each (each becomes the current version's binding). The Worker must exist. */
export async function putWorkerSecrets(api: CfApi, account: string, worker: string, secrets: Record<string, string>): Promise<string[]> {
  const done: string[] = [];
  for (const [name, text] of Object.entries(secrets)) {
    await api.json("PUT", `/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/secrets`, { name, text, type: "secret_text" });
    done.push(name);
  }
  return done;
}

/** The scaffold `voidbase init` writes: a declaration with an example of each tier, and how the values arrive. */
export function declarationScaffold(pkg = "@voidbase-cloud/voidbase"): string {
  return `// The app's configuration: declared here, valued in pb_secrets/secrets.json (git-ignored) on your machine and in
// the Worker's secrets and vars once deployed. Read by \`voidbase serve\` and \`voidbase deploy\`; in hooks,
// $os.getenv("NAME"); in TypeScript, \`await definition.read(env)\` gives the typed values.
//
//   .secret()   the Worker's encrypted secrets, never listed, never in a build (\`voidbase secrets push\` stores them)
//   (plain)     server configuration: a plain Worker var, hooks and routes only
//   .public()   a Worker var the browser may know too: a client build inlines it as import.meta.env.NAME
//   local()     the tooling's own (the deploy token, the deploy target): read here or in CI, never deployed
import { defineSecrets, describe, local, string, number } from "${pkg}/secrets";

export default defineSecrets({
  // SMTP_PASSWORD: describe(string().secret(), "the mail provider's SMTP password"),
  // MAX_UPLOAD_MB: number().default(10),
  // PUBLIC_SITE_URL: string().optional().public(),
  // VOIDBASE_DEPLOY_CF_API_KEY: local(string().optional(), "the deploy token (voidbase token prints the link)"),
});
`;
}
