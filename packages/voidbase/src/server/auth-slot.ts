// What the core asks about auth, and whom it asks.
//
// Auth is a plugin (src/server/plugins/auth.ts, providing auth@1), and the core neither imports it nor decides for
// itself who is signed in or what a superuser is: it asks whoever provides the interface, through this slot. app.ts
// hands the kernel's lookup in once the plugins are loaded, and looks it up again on every question, because the
// provider can be replaced while the instance runs. Before that, and in an instance running without an auth
// provider, nobody is signed in, every superuser route answers 401, and the instance says at boot and on
// /api/plugins which core interface it is missing. That is the bare instance the plan calls an invariant: the core
// does not quietly grow an auth of its own to fill the gap.
import type { Context } from "hono";
import { forbidden, unauthorized } from "./errors";
import type { Auth } from "./interfaces";
import type { AppEnv, AuthRecord, Bindings } from "./types";

let lookup: () => Auth | undefined = () => undefined;

/** app.ts: how to reach whoever provides auth@1 now */
export function provideAuthLookup(fn: () => Auth | undefined): void { lookup = fn; }
export const authProvider = (): Auth | undefined => lookup();

/** who is making this request, or nobody */
export async function authenticate(request: Request, env: Bindings): Promise<AuthRecord | null> {
  const provider = authProvider();
  return provider ? provider.authenticate(request, env) : null;
}

/** the record behind a token the provider issued; an empty token is nobody without asking */
export async function fromToken(token: string, env: Bindings, type?: string): Promise<AuthRecord | null> {
  const provider = authProvider();
  return token && provider ? provider.fromToken(token, env, type) : null;
}

export const isSuperuser = (record: AuthRecord | null | undefined): boolean => !!record && !!authProvider()?.isSuperuser(record);

/** the fields `@request.auth.<field>` may name beyond an auth collection's own, by name */
export const authFields = (): string[] => (authProvider()?.schema() ?? []).map((f) => f.name);

export function requireAuth(c: Context<AppEnv>): AuthRecord {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("The request requires valid record authorization token.");
  return auth;
}

export function requireSuperuser(c: Context<AppEnv>): AuthRecord {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("The request requires valid record authorization token.");
  if (!isSuperuser(auth)) throw forbidden("The authorized record is not allowed to perform this action.");
  return auth;
}
