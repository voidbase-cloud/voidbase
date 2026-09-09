// Feature flags, evaluated per request from Cloudflare Flagship.
//
// The deploy bakes the declared flags and their defaults into VOIDBASE_FLAGS and binds the Flagship app as FLAGS
// (src/node/flagship.ts). Here, once who is asking is known, every declared flag is evaluated with the request's
// targeting key (the signed-in record, else the client's address, so a percentage rollout is sticky per person) and
// the answers are written onto this request's env as strings, next to the vars, so `c.env.KEY`, `$os.getenv(KEY)`
// and every reader of a boolean knob sees the flag's value without knowing it is one. Without the binding (Bun,
// a token that could not reach Flagship) the baked defaults are what the env already carries.
interface FlagsBinding { getBooleanValue(key: string, fallback: boolean, context?: Record<string, unknown>): Promise<boolean> }

export const FLAGS_VAR = "VOIDBASE_FLAGS";

/** the declared flags and their baked defaults, from the var the deploy wrote */
export function declaredFlags(env: object): Record<string, boolean> {
  try { const v = (env as Record<string, unknown>)[FLAGS_VAR]; return v ? (JSON.parse(String(v)) as Record<string, boolean>) : {}; } catch { return {}; }
}

/** this request's env with the flags' values on it; the same env when there is nothing to evaluate */
export async function withFlags<E extends object>(env: E, targetingKey: string): Promise<E> {
  const flags = declaredFlags(env);
  const binding = (env as Record<string, unknown>).FLAGS as FlagsBinding | undefined;
  const keys = Object.keys(flags);
  if (!keys.length || !binding || typeof binding.getBooleanValue !== "function") return env;
  const values = await Promise.all(keys.map(async (k) => [k, String(await binding.getBooleanValue(k, flags[k]!, { targetingKey }).catch(() => flags[k]!))] as const));
  return { ...env, ...Object.fromEntries(values) };
}
