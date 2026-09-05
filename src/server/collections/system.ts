import systemJSON from "./system.json";
import { jsonToCollection, type Collection } from "./model";
import { randomString } from "../ids";

// Secrets never ship in snapshots; PocketBase generates them per collection. So do we, at bootstrap.
const SECRET_OPTIONS = ["authToken", "passwordResetToken", "emailChangeToken", "verificationToken", "fileToken"];

export function systemCollections(): Collection[] {
  return (systemJSON as Record<string, unknown>[]).map((json) => {
    const c = jsonToCollection(json);
    if (c.type === "auth") {
      for (const key of SECRET_OPTIONS) {
        const cfg = (c.options[key] as Record<string, unknown> | undefined) ?? {};
        if (!cfg.secret) c.options[key] = { ...cfg, secret: randomString(50) };
      }
    }
    return c;
  });
}
