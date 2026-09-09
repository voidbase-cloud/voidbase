import { defineConfig, loadEnv } from "vite";
import { voidPlugin } from "void";
import { pbHooksPlugin } from "./hooks-plugin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [voidPlugin({ persistTo: env.VOIDBASE_PERSIST_TO || undefined }), pbHooksPlugin({ dir: env.VOIDBASE_HOOKS_DIR || "pb_hooks", migrationsDir: env.VOIDBASE_MIGRATIONS_DIR || "pb_migrations", pluginsDir: env.VOIDBASE_PLUGINS_DIR || "pb_plugins", hubEntry: "./src/server/hub.ts" })],
  };
});
