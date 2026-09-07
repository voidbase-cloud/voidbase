import { defineHandler } from "void";
import { pb } from "@voidbase-cloud/voidbase/adapter";

// a declared secret, read the way a hook reads it (Bun: from the process environment voidbase serve filled from
// vb_secrets/secrets.json; Cloudflare: from the Worker's secrets)
export const GET = defineHandler(() => ({ fromOs: pb.$os.getenv("TEST_SECRET"), missing: pb.$os.getenv("OTHER_SECRET") }));
