import { defineEnv, string } from "void/env";

export default defineEnv({
  // First superuser, upserted at bootstrap when both are set (mirrors the starter's entrypoint).
  VOIDBASE_SUPERUSER_EMAIL: string().optional(),
  VOIDBASE_SUPERUSER_PASSWORD: string().optional(),
  // read by pb_hooks via $os.getenv (the starter's audit log uses AUDITLOG=posts,users)
  AUDITLOG: string().optional(),
  // PocketBase's --encryptionEnv equivalent: when set (16, 24 or 32 chars) the settings row is stored AES-GCM encrypted
  VOIDBASE_ENCRYPTION_KEY: string().optional(),
});
