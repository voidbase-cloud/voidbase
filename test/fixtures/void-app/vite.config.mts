import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidbaseAdapter } from "@voidbase-cloud/voidbase/adapter/plugin";

// `vite build` produces a voidbase app: pb_public for the client, .voidbase/void-app.ts for the server code.
export default defineConfig({
  plugins: [voidPlugin(), voidbaseAdapter({ quiet: true })],
});
