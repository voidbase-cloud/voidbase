// pb_secrets/: the app's secrets, declared where the tooling can read them and valued where git cannot see them.
//
//   pb_secrets/main.pb.js      the declaration, committed: `secrets({ NAME: "what it is", ... })`. Read, never run.
//   pb_secrets/secrets.json    the values, git-ignored: `{ "NAME": "value", ... }`. On a dev machine only.
//
// `voidbase serve` loads the values into the process environment, so `$os.getenv("NAME")` and the app's own code see
// them exactly as they will on Cloudflare. `voidbase deploy` stores the values as the Worker's secrets (encrypted,
// per Worker, so two instances on one account never share one) and refuses to deploy while a declared secret has
// neither a local value nor one already on the Worker: a CI checkout has no secrets.json, and that is the point --
// the values are pushed once from a machine that has them (`voidbase secrets push`) and the pipeline needs nothing
// but the deploy token. Cloudflare's account-level Secrets Store is deliberately not used: one store is shared by
// every Worker of the account, and its bindings are read asynchronously, which `$os.getenv` is not.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import type { CfApi } from "../cloud/rest";

export const SECRETS_DIR = "pb_secrets";
export const DECLARATION_FILE = "main.pb.js";
export const VALUES_FILE = "secrets.json";
const NAME = /^[A-Z][A-Z0-9_]*$/;

export interface SecretsDeclaration {
  /** the file the names came from */
  file: string;
  /** declared names, in file order */
  names: string[];
  /** what each one is, when the declaration says */
  descriptions: Record<string, string>;
}

/**
 * The names a declaration file names, without evaluating it: `secrets({ A: "what A is", B: "" })`, or
 * `secrets(["A", "B"])`. The same reader serves the adapter's `defineSecrets({...})` in vb_secrets/main.ts.
 */
export function parseSecretsDeclaration(code: string, file = DECLARATION_FILE, callee: string | string[] = ["secrets", "defineSecrets"]): SecretsDeclaration {
  const callees = new Set(Array.isArray(callee) ? callee : [callee]);
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const names: string[] = []; const descriptions: Record<string, string> = {};
  const text = (n: ts.Node | undefined) => (n && (ts.isStringLiteralLike(n) || ts.isIdentifier(n)) ? n.text : null);
  const add = (name: string | null, description: string | null) => {
    if (!name) return;
    if (!NAME.test(name)) throw new Error(`voidbase: ${file}: "${name}" is not a secret name (UPPER_CASE, letters, digits and underscores, like an environment variable)`);
    if (!names.includes(name)) names.push(name);
    if (description) descriptions[name] = description;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const fn = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      const arg = node.arguments[0];
      if (callees.has(fn) && arg) {
        if (ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p)) {
              const init = p.initializer;
              const description = ts.isStringLiteralLike(init) ? init.text
                : ts.isObjectLiteralExpression(init) ? text(init.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && text(q.name) === "description")?.initializer) : null;
              add(text(p.name), description);
            } else if (ts.isShorthandPropertyAssignment(p)) add(p.name.text, null);
          }
        } else if (ts.isArrayLiteralExpression(arg)) for (const el of arg.elements) add(text(el), null);
        else throw new Error(`voidbase: ${file}: ${fn}() takes an object of names ({ NAME: "what it is" }) or an array of names`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { file, names, descriptions };
}

/** The declaration of a pb_secrets/ directory, or null when there is none. */
export function readSecretsDeclaration(dir = SECRETS_DIR): SecretsDeclaration | null {
  const file = join(resolve(dir), DECLARATION_FILE);
  if (!existsSync(file)) return null;
  return parseSecretsDeclaration(readFileSync(file, "utf8"), file);
}

/** The values of a pb_secrets/ directory (`secrets.json`), or null when the file is absent. Every value is a string. */
export function readSecretsValues(dir = SECRETS_DIR): Record<string, string> | null {
  const file = join(resolve(dir), VALUES_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`voidbase: ${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`voidbase: ${file} must be an object: { "NAME": "value" }`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!NAME.test(k)) throw new Error(`voidbase: ${file}: "${k}" is not a secret name (UPPER_CASE, letters, digits and underscores)`);
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

export interface SecretsState {
  dir: string;
  declaration: SecretsDeclaration | null;
  values: Record<string, string> | null;
  /** declared names with a local value */
  provided: string[];
  /** declared names without a local value */
  unprovided: string[];
  /** local values that no declaration names */
  undeclared: string[];
}

/** What a pb_secrets/ directory declares and holds, and how the two compare. */
export function secretsState(dir = SECRETS_DIR): SecretsState {
  const declaration = readSecretsDeclaration(dir);
  const values = readSecretsValues(dir);
  if (!declaration && values && Object.keys(values).length) {
    throw new Error(`voidbase: ${join(resolve(dir), VALUES_FILE)} holds ${Object.keys(values).length} secret(s) but nothing declares them. Name them in ${join(dir, DECLARATION_FILE)}:\n  secrets({ ${Object.keys(values).map((k) => `${k}: ""`).join(", ")} })`);
  }
  const names = declaration?.names ?? [];
  const have = new Set(Object.keys(values ?? {}));
  return {
    dir: resolve(dir), declaration, values,
    provided: names.filter((n) => have.has(n)),
    unprovided: names.filter((n) => !have.has(n)),
    undeclared: [...have].filter((n) => !names.includes(n)),
  };
}

/**
 * Puts the local values into an environment (the process's, for `voidbase serve` and `voidbase deploy`), never over
 * a value that is already there. Returns what to tell the user: names loaded, names still missing, names nobody
 * declared.
 */
export function loadSecrets(dir = SECRETS_DIR, into: Record<string, string | undefined> = process.env): { loaded: string[]; missing: string[]; undeclared: string[]; state: SecretsState } {
  const state = secretsState(dir);
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(state.values ?? {})) { if (into[k] === undefined || into[k] === "") { into[k] = v; loaded.push(k); } }
  const missing = state.unprovided.filter((n) => !into[n]);
  return { loaded, missing, undeclared: state.undeclared, state };
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

/** The scaffold `voidbase init` writes: a declaration with nothing in it yet, and how to fill it. */
export function declarationScaffold(): string {
  return `/// <reference path="../pb_data/types.d.ts" />
// The secrets this app needs. This file is read by \`voidbase serve\` and \`voidbase deploy\`, never run: it names the
// secrets, and pb_secrets/secrets.json (git-ignored) holds their values on your machine:
//
//   { "SMTP_PASSWORD": "..." }
//
// \`voidbase deploy\` stores the values as this Worker's secrets; \`voidbase secrets push\` does only that. A checkout
// without secrets.json (CI) deploys as long as every name below is already on the Worker. In hooks: $os.getenv("NAME").
secrets({
  // SMTP_PASSWORD: "the mail provider's SMTP password",
});
`;
}
