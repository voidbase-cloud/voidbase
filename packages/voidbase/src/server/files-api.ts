// File tokens (apis/file.go fileToken): short-lived JWTs signed with the collection's fileToken secret that
// let a client fetch protected files with ?token=... The files route uses `protectedAccess` for the check.
import type { Context, Hono } from "hono";
import { fromToken } from "./auth-slot";
import { ipInList, realIP } from "./hardening";
import type { Collection } from "./collections/model";
import { unauthorized } from "./errors";
import { HookRecord } from "./hooks/record";
import { trigger } from "./hooks/runtime";
import { signJWT } from "./jwt";
import { recordMatchesRule, type RecordContext } from "./records/service";
import { rowToValues } from "./records/values";
import { loadSettings } from "./settings";
import type { AppEnv, AuthRecord, Row } from "./types";

const tokenOption = (c: Collection) => ((c.options as Record<string, unknown>).fileToken ?? {}) as { secret?: string; duration?: number };

export async function newFileToken(auth: AuthRecord): Promise<string> {
  const opt = tokenOption(auth.collection);
  const key = String(auth.row.tokenKey ?? "") + String(opt.secret ?? "");
  if (!key) throw new Error("missing or invalid signing key");
  return signJWT({ type: "file", id: String(auth.row.id), collectionId: auth.collection.id }, key, Number(opt.duration ?? 0) || 180);
}

export function mountFilesApi(app: Hono<AppEnv>) {
  app.post("/api/files/token", async (c) => {
    const auth = c.get("auth");
    if (!auth) throw unauthorized("The request requires valid record authorization token.");
    const token = await newFileToken(auth);
    const ev = { app: undefined as unknown, token, record: HookRecord.fromRow(auth.collection, auth.row), next: async () => undefined as unknown };
    let res: Response | null = null;
    await trigger("onFileTokenRequest", ev, auth.collection.name, async () => { res = c.json({ token: ev.token }); });
    return res ?? c.json({ token });
  });
}

// protected file: the ?token= file token (superusers subject to the IP allowlist) must satisfy the view rule
export async function protectedAccess(c: Context<AppEnv>, ctx: RecordContext, collection: Collection, row: Row): Promise<boolean> {
  const token = c.req.query("token") ?? "";
  let auth = token ? await fromToken(token, c.env, "file") : null;
  if (auth && auth.collection.name === "_superusers") {
    const allowed = (await loadSettings(c.env.DB)).superuserIPs;
    if (allowed.length && !ipInList(allowed, await realIP(c))) auth = null;
  }
  const superuser = !!auth && auth.collection.name === "_superusers";
  const viewRule = collection.viewRule;
  if (superuser) return true;
  if (viewRule === null) return false;
  const fctx: RecordContext = { ...ctx, auth, superuser, request: { ...ctx.request, auth: auth ? { collection: auth.collection, row: auth.row } : null, context: "protectedFile" } };
  if (viewRule.trim() === "") return true;
  return recordMatchesRule(fctx, collection, viewRule, rowToValues(collection, row));
}
