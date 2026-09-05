import { defineConfig, loadEnv } from "vite";
import { voidPlugin } from "void";
import { pbHooksPlugin } from "./hooks-plugin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [voidPlugin(), pbHooksPlugin({ dir: env.VOIDBASE_HOOKS_DIR || "pb_hooks", migrationsDir: env.VOIDBASE_MIGRATIONS_DIR || "pb_migrations" })],
  };
});
