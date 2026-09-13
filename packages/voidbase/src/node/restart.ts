// Starting this process again, the way it was started: what a local rebuild's last step does (src/node/rebuild.ts).
//
// Plugins are loaded once, when an instance starts, so a new version runs only in a new process. The CLI records how it
// was started before anything changes it (`recordStart`, called by bin/voidbase.ts): the arguments, and the value each
// path `voidbase serve` derives had in the environment then. A restart stops the server, starts the same command with
// those values put back (so the new process derives them again, and loads the version now in place rather than
// inheriting the old one's paths), and exits.

/** the environment `voidbase serve` fills in for itself while opening an instance (src/node/serve.ts, openLocal) */
export const DERIVED = ["VOIDBASE_SECRETS_DIR", "VOIDBASE_HOOKS_DIR", "VOIDBASE_MIGRATIONS_DIR", "VOIDBASE_PLUGINS_DIR", "VOIDBASE_DECLARATION_DIR", "VOIDBASE_PUBLIC_DIR", "VOIDBASE_PROJECT_BAKED", "VOIDBASE_PANEL_PATH", "VOIDBASE_PANEL_GUARD", "VOIDBASE_AUTOMIGRATE"] as const;

export function recordStart(): void {
  if (process.env.VOIDBASE_RESTART_ARGV) return;
  process.env.VOIDBASE_RESTART_ARGV = JSON.stringify(process.argv);
  process.env.VOIDBASE_RESTART_ENV = JSON.stringify(Object.fromEntries(DERIVED.map((k) => [k, process.env[k] ?? null])));
}

/** the command and environment a restart starts; null when this process was not started by the CLI */
export function restartCommand(env: Record<string, string | undefined> = process.env): { cmd: string[]; env: Record<string, string | undefined> } | null {
  if (!env.VOIDBASE_RESTART_ARGV) return null;
  const argv = JSON.parse(env.VOIDBASE_RESTART_ARGV) as string[];
  const original = JSON.parse(env.VOIDBASE_RESTART_ENV ?? "{}") as Record<string, string | null>;
  const next: Record<string, string | undefined> = { ...env };
  for (const [k, v] of Object.entries(original)) { if (v === null) delete next[k]; else next[k] = v; }
  // the standalone executable runs itself; a script is run by Bun with its path
  const compiled = /[\\/]\$bunfs[\\/]|~BUN/.test(argv[1] ?? "");
  return { cmd: compiled ? [argv[0]!, ...argv.slice(2)] : argv, env: next };
}

export function restartProcess(stop: () => void): void {
  const command = restartCommand();
  if (!command) throw new Error("this instance was not started by the voidbase CLI, so it cannot start itself again: restart it to load the new version");
  stop();
  Bun.spawn(command.cmd, { stdio: ["ignore", "inherit", "inherit"], env: command.env, cwd: process.cwd() }).unref();
  setTimeout(() => process.exit(0), 50);
}
