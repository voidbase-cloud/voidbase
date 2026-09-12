import { defineHandler } from "void";
import { pb } from "@voidbase-cloud/voidbase/adapter";
import config from "../../vb_secrets/main";

// declared configuration, read the way a hook reads it (Bun: from the process environment voidbase serve filled
// from vb_secrets/secrets.json and the defaults; Cloudflare: from the Worker's secrets and vars), and typed through
// the same declaration
export const GET = defineHandler(async () => {
  const parsed = await config.evaluate((n) => pb.$os.getenv(n));
  return { fromOs: pb.$os.getenv("TEST_SECRET"), missing: pb.$os.getenv("OTHER_SECRET"), max: parsed.values.MAX_ITEMS, label: parsed.values.PUBLIC_LABEL, unresolved: parsed.missing };
});
