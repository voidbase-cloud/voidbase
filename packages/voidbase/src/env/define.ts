// The app's configuration, declared once with Void's validators and stored in each deploy's environment
// (twelve-factor III: config in the environment, declared in code, never grouped by environment):
//
//   // pb_secrets/main.ts (a Void app: vb_secrets/main.ts)
//   import { defineSecrets, secret, server, browser, local, string, number, url } from "@voidbase-cloud/voidbase/secrets";
//
//   export default defineSecrets({
//     SMTP_PASSWORD: secret(string(), "the mail provider's password"),
//     ADMIN_EMAILS: server(string().default(""), "who may open the admin pages"),
//     MAX_INSTANCES: server(number().default(5)),
//     PUBLIC_API_URL: browser(url().optional(), "where the browser reaches the API"),
//     VOIDBASE_DEPLOY_CF_API_KEY: local(string(), "the deploy token"),
//   });
//
// Every key states who may read it, and the maintainer of this file answers for that: a key without a tier is
// refused at definition and at build. The tier decides where the value lives:
//
//   secret()    the Worker's encrypted secrets; read by hooks and routes; never listed, never in a build
//   server()    server configuration: the Worker's plain vars; read by hooks and routes; never in a client build
//   browser()   the Worker's plain vars *and* the client build (`import.meta.env.KEY`): what the browser may know
//   local()     the tooling's own: the deploy token, the deploy target; read by voidbase on this machine or in CI,
//               never stored on the Worker, never in a build
//
// The validators are Void's own (`string()`, `number()`, `boolean()`, `url()`, `email()`, `oneOf()`, `json()`,
// each with `.optional()` and `.default()`), the same ones a Void project's env.ts uses, so one vocabulary serves
// both; Void's `.secret()` and `.public()` markers are accepted as the tier too. Any Standard Schema validator works.
//
// Values come from the deploy's environment: locally `secrets.json` (git-ignored) beside the declaration, then the
// shell; on Cloudflare the Worker's secrets and vars. `voidbase serve`, `voidbase deploy` and the adapter's build
// parse them through the validators, so a default is filled in, a number is a number, and a bad or missing value
// stops the process with the key's name, never its value.
//
// This module is imported by the app's own code too (`await definition.read(c.env)` for typed access), so it must
// stay small: Void's validators and nothing else.
import { boolean, email, json, number, oneOf, string, url } from "void/env";

export { boolean, email, json, number, oneOf, string, url };

// Standard Schema V1, inlined as the spec allows
export interface StandardSchema<Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
}
type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<{ readonly message: string }> };
export type OutputOf<S> = S extends StandardSchema<infer O> ? O : never;

export type Access = "secret" | "server" | "public" | "local" | "flag";

export interface Entry<S extends StandardSchema = StandardSchema> {
  schema: S;
  /** the tier; without one, Void's `.secret()` / `.public()` marker on the validator must say it */
  access?: Access;
  description?: string;
}

/** Void's marker, set by `.secret()` and `.public()` on its validators (a Symbol.for, so the same across copies). */
const VOID_MARKER = Symbol.for("void.env.secretOverride");
const markerOf = (schema: unknown): Access | undefined => {
  const m = schema && typeof schema === "object" ? (schema as Record<symbol, unknown>)[VOID_MARKER] : undefined;
  return m === "secret" ? "secret" : m === "public" ? "public" : undefined;
};

const ENTRY = Symbol.for("voidbase.secrets.entry");
type Marked<S extends StandardSchema> = Entry<S> & { [ENTRY]: true };
const entry = <S extends StandardSchema>(e: Entry<S>): Marked<S> => ({ ...e, [ENTRY]: true });
const isEntry = (v: unknown): v is Marked<StandardSchema> => !!v && typeof v === "object" && ENTRY in (v as object);

/** Read by hooks and routes only: one of the Worker's encrypted secrets, never listed, never in a build. */
export function secret<S extends StandardSchema>(schema: S, description?: string): Marked<S> { return entry({ schema, access: "secret", description }); }
/** Read by hooks and routes only: a plain Worker var, never in a client build. */
export function server<S extends StandardSchema>(schema: S, description?: string): Marked<S> { return entry({ schema, access: "server", description }); }
/** Read by everyone, the browser included: a Worker var the client build inlines as `import.meta.env.KEY`. */
export function browser<S extends StandardSchema>(schema: S, description?: string): Marked<S> { return entry({ schema, access: "public", description }); }
/** Read by voidbase's own tooling here or in CI (the deploy token, the deploy target): never deployed. */
export function local<S extends StandardSchema>(schema: S, description?: string): Marked<S> { return entry({ schema, access: "local", description }); }
/**
 * A feature flag: a boolean the app reads at request time from Cloudflare Flagship (the deploy creates the flag
 * with this default and binds the app), or this default where Flagship is not reachable. Booleans only, for now.
 */
export function flag<S extends StandardSchema>(schema: S, description?: string): Marked<S> { return entry({ schema, access: "flag", description }); }

export type Spec = Record<string, StandardSchema | Entry>;
type SchemaOf<E> = E extends Entry<infer S> ? S : E extends StandardSchema ? E : never;
/** The typed configuration a definition parses to. */
export type Values<T extends Spec> = { [K in keyof T]: OutputOf<SchemaOf<T[K]>> };
export type ValuesOf<D> = D extends Definition<infer T> ? Values<T> : never;

export interface KeyInfo {
  name: string;
  access: Access;
  description?: string;
  /** the validator accepts no value at all: it has a default or is optional */
  optional: boolean;
  /** the value the validator fills in when none is given, as it will be stored (a string), or undefined */
  fallback?: string;
}

/** What parsing a set of raw values produced. Values never appear in `missing` or `invalid`. */
export interface Evaluation<T extends Spec> {
  /** every key that parsed, with its typed value */
  values: Partial<Values<T>>;
  /** every key that parsed, as the string the environment stores (numbers and booleans stringified, objects as JSON) */
  stored: Record<string, string>;
  /** keys with no value and no default */
  missing: string[];
  /** keys whose value the validator refused: name and why */
  invalid: { name: string; message: string }[];
}

const NAME = /^[A-Z][A-Z0-9_]*$/;
/** where raw values come from: an environment object, or a lookup (`(name) => $os.getenv(name)` in a hook or route) */
export type Source = Record<string, unknown> | ((name: string) => unknown);

/** A configuration value as the environment stores it: environments hold strings. */
export function toStored(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

const validate = async <O>(schema: StandardSchema<O>, value: unknown): Promise<StandardResult<O>> => schema["~standard"].validate(value);

export class Definition<T extends Spec> {
  readonly entries: { [K in keyof T]: Required<Pick<Entry<SchemaOf<T[K]>>, "schema" | "access">> & Pick<Entry, "description"> };
  constructor(spec: T) {
    const entries = {} as Definition<T>["entries"];
    for (const [name, v] of Object.entries(spec)) {
      if (!NAME.test(name)) throw new Error(`voidbase: "${name}" is not a configuration name (UPPER_CASE, letters, digits and underscores, like an environment variable)`);
      const e: Entry = isEntry(v) ? { schema: v.schema, access: v.access, description: v.description } : { schema: v as StandardSchema };
      if (!e.schema || typeof e.schema !== "object" || !("~standard" in e.schema)) throw new Error(`voidbase: ${name} needs a validator (string(), number(), url(), ... from @voidbase-cloud/voidbase/secrets, or any Standard Schema)`);
      const access = e.access ?? markerOf(e.schema);
      if (!access) throw new Error(`voidbase: ${name} has no tier. Every key says who may read it: secret(...), server(...), browser(...), flag(...) or local(...)`);
      if (access === "flag") {
        // only a boolean validator turns the strings "true" and "false" into the booleans they name
        const on = e.schema["~standard"].validate("true"), off = e.schema["~standard"].validate("false");
        const isBool = (r: unknown) => !(r instanceof Promise) && !(r as { issues?: unknown }).issues && typeof (r as { value?: unknown }).value === "boolean";
        if (!isBool(on) || !isBool(off)) throw new Error(`voidbase: ${name} is a flag, and a flag is a boolean (boolean(), boolean().default(false)); other types wait for Flagship's variants`);
      }
      (entries as Record<string, unknown>)[name] = { schema: e.schema, access, description: e.description };
    }
    this.entries = entries;
  }
  /** the names, in declaration order */
  get names(): (keyof T & string)[] { return Object.keys(this.entries) as (keyof T & string)[]; }
  /** the names of one tier, or of several */
  of(...access: Access[]): (keyof T & string)[] { return this.names.filter((n) => access.includes(this.entries[n].access)); }
  /** what each key is, without any value */
  async info(): Promise<KeyInfo[]> {
    const out: KeyInfo[] = [];
    for (const name of this.names) {
      const e = this.entries[name];
      const empty = await validate(e.schema, undefined);
      const ok = !empty.issues;
      out.push({ name, access: e.access, description: e.description, optional: ok, fallback: ok ? toStored((empty as { value: unknown }).value) : undefined });
    }
    return out;
  }
  /**
   * Parses raw values (an environment: strings, or nothing) through the validators. Nothing throws: the result says
   * which keys are missing and which were refused, by name, so a caller can stop with a list instead of one error.
   * `only` restricts the parse to some tiers (a client build reads `public` and nothing else).
   */
  async evaluate(raw: Source, only?: Access[]): Promise<Evaluation<T>> {
    const values: Record<string, unknown> = {}; const stored: Record<string, string> = {}; const missing: string[] = []; const invalid: { name: string; message: string }[] = [];
    const get = typeof raw === "function" ? raw : (n: string) => raw[n];
    for (const name of only ? this.of(...only) : this.names) {
      const e = this.entries[name];
      const got = get(name); const input = got === "" ? undefined : got;
      const r = await validate(e.schema, input);
      if (r.issues) {
        if (input === undefined) { missing.push(name); continue; }
        // a validator may quote what it refused (Void's url() does): the report never carries the value
        const shown = typeof input === "string" ? input : String(input);
        invalid.push({ name, message: r.issues.map((i) => (shown ? i.message.split(shown).join("<value>") : i.message)).join("; ") });
        continue;
      }
      if (r.value === undefined) continue; // optional and absent: the app reads undefined, as declared
      values[name] = r.value; const s = toStored(r.value); if (s !== undefined) stored[name] = s;
    }
    return { values: values as Partial<Values<T>>, stored, missing, invalid };
  }
  /**
   * Typed access from the app's own code: `await definition.read((n) => pb.$os.getenv(n))` in a route or hook works
   * on both runtimes; `read(c.env)` on a Worker, `read(process.env)` on Bun.
   * Throws with the names of the keys that are missing or refused, never their values.
   */
  async read(raw: Source, only?: Access[]): Promise<Values<T>> {
    const r = await this.evaluate(raw, only);
    const problems = [...r.missing.map((n) => `${n}: missing`), ...r.invalid.map((i) => `${i.name}: ${i.message}`)];
    if (problems.length) throw new Error(`voidbase: configuration: ${problems.join(", ")}`);
    return r.values as Values<T>;
  }
}

/**
 * Declares the app's configuration. The result is the declaration `voidbase serve`, `voidbase deploy` and the
 * adapter read, and the typed reader the app's code uses:
 *
 *     export default defineSecrets({ SMTP_PASSWORD: string().secret(), MAX: number().default(5) });
 *     // elsewhere: const { MAX } = await definition.read(c.env);   MAX is a number
 */
export function defineSecrets<const T extends Spec>(spec: T): Definition<T> {
  return new Definition(spec);
}

export const isDefinition = (v: unknown): v is Definition<Spec> => v instanceof Definition || (!!v && typeof v === "object" && typeof (v as Definition<Spec>).evaluate === "function" && !!(v as Definition<Spec>).entries);
