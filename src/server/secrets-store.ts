// Secrets Store bindings, made to look like the Worker's own secrets.
//
// A secret from the account's Secrets Store arrives on `env` as an object whose value is behind an async `get()`,
// while everything in voidbase reads configuration synchronously: `c.env.KEY`, `$os.getenv`, the env schema. So
// each isolate resolves the bindings once, on its first request, cron tick or queue batch, and puts the string
// where the object was. The env object is the same one for the life of the isolate, so this happens once; a
// failure is retried by the next caller. Other bindings are told apart by what else they can do: a bucket puts,
// a database prepares, a namespace makes ids, a workflow creates, a flag service evaluates.
const resolved = new WeakMap<object, Promise<void>>();
const NOT_A_SECRET = ["put", "prepare", "list", "idFromName", "fetch", "create", "send", "writeDataPoint", "limit", "getBooleanValue", "connectionString"];

export const isSecretBinding = (v: unknown): v is { get(): Promise<string> } =>
  !!v && typeof v === "object" && typeof (v as { get?: unknown }).get === "function" && !NOT_A_SECRET.some((m) => m in (v as object));

export function resolveSecretBindings(env: Record<string, unknown>): Promise<void> {
  let p = resolved.get(env);
  if (!p) {
    const keys = Object.keys(env).filter((k) => isSecretBinding(env[k]));
    if (!keys.length) { p = Promise.resolve(); resolved.set(env, p); return p; }
    p = Promise.all(keys.map(async (k) => { env[k] = await (env[k] as { get(): Promise<string> }).get(); })).then(() => undefined).catch((err) => { resolved.delete(env); throw err; });
    resolved.set(env, p);
  }
  return p;
}
