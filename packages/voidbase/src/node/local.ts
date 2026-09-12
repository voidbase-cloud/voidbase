// Instances on this machine: the same job the prebuilt executable does, for people who installed the npm package.
//
// The executable's model is one directory with a `pb_data` beside the binary, which is perfect until you want a
// second one and have to remember where you put the first. This keeps a small registry of the instances you have
// made, so `local ls` answers "what have I got and which port is it on" without you keeping notes.
//
// Nothing here touches Cloudflare. A local instance is a directory and a row in a JSON file, and deleting the row
// leaves the directory alone unless you ask for it to go too.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LocalInstance {
  name: string;
  dir: string;
  /** the port `local start` uses, chosen once so it stays the same between runs */
  port: number;
  created: string;
}

/** where the registry lives: one file, easy to read, easy to delete */
export const home = (): string => process.env.VOIDBASE_HOME || join(homedir(), ".voidbase");
export const registryPath = (): string => join(home(), "instances.json");
/** where an instance goes when the caller does not say */
export const defaultDir = (name: string): string => join(home(), "instances", name);

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function checkName(name: string): string | null {
  if (!NAME.test(name)) return `"${name}" is not a usable name: lower case letters, digits and dashes, up to 40`;
  return null;
}

export function readRegistry(): LocalInstance[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { instances?: LocalInstance[] };
    return Array.isArray(parsed.instances) ? parsed.instances : [];
  } catch {
    return []; // a corrupt registry is not worth failing a command over: it is a convenience, not the truth
  }
}

export function writeRegistry(instances: LocalInstance[]): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(registryPath(), `${JSON.stringify({ instances }, null, 2)}\n`);
}

export const find = (name: string): LocalInstance | undefined => readRegistry().find((i) => i.name === name);

/**
 * The first port that nothing is listening on and no other instance has claimed. Both halves matter: a stopped
 * instance is not listening, so without the registry check two instances made in a row would both get 8090 and the
 * second would fail to start.
 */
export async function freePort(from = 8090): Promise<number> {
  const taken = new Set(readRegistry().map((i) => i.port));
  for (let port = from; port < from + 200; port++) {
    if (taken.has(port)) continue;
    if (!(await inUse(port))) return port;
  }
  throw new Error(`no free port between ${from} and ${from + 200}`);
}

export async function inUse(port: number): Promise<boolean> {
  try {
    const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
    s.stop(true);
    return false;
  } catch {
    return true;
  }
}

/** is something answering as voidbase on that port right now */
export async function isRunning(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

/** how much disk the instance is using, so `ls` can say something useful about it */
export function sizeOf(dir: string): number {
  let total = 0;
  const walk = (at: string) => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(join(dir, "pb_data"));
  return total;
}

export const human = (bytes: number): string =>
  bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes > 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.round(bytes / 1024)} kB`;

export interface ScaffoldOptions {
  /** the voidbase version to pin in package.json */
  version: string;
  /** where .env.example lives, so a checkout and an installed package both find it */
  root: string;
  /** a local instance does not deploy, so it needs neither the deploy verbs nor a package.json */
  minimal?: boolean;
}

/**
 * The files a voidbase directory starts with. `voidbase init` and `voidbase local new` both call this, so a project
 * and a local instance are the same shape and moving between them is moving a directory.
 */
export function scaffold(dir: string, o: ScaffoldOptions): string[] {
  const wrote: string[] = [];
  for (const d of ["pb_hooks", "pb_migrations", "pb_secrets"]) mkdirSync(join(dir, d), { recursive: true });

  const hook = join(dir, "pb_hooks/main.pb.js");
  if (!existsSync(hook)) {
    writeFileSync(hook, `/// <reference path="../pb_data/types.d.ts" />\nrouterAdd("GET", "/api/hello", (e) => e.json(200, { hello: "voidbase" }));\n`);
    wrote.push("pb_hooks/main.pb.js");
  }

  const gi = join(dir, ".gitignore");
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const lines = ["pb_data/", "pb_secrets/secrets.json", ".cloud/"].filter(
    (l) => !have.split("\n").some((x) => x.trim() === l || x.trim() === l.replace(/\/$/, "")),
  );
  if (lines.length) {
    writeFileSync(gi, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
    wrote.push(".gitignore");
  }

  if (o.minimal) return wrote;

  const env = join(dir, ".env");
  if (!existsSync(env) && existsSync(join(o.root, ".env.example"))) {
    cpSync(join(o.root, ".env.example"), env);
    wrote.push(".env");
  }

  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(
      pkg,
      `${JSON.stringify(
        {
          name: dir.split("/").filter(Boolean).at(-1) ?? "voidbase-app",
          private: true,
          type: "module",
          scripts: { dev: "voidbase serve --dev", start: "voidbase serve", deploy: "voidbase deploy", version: "voidbase secrets" },
          dependencies: { "@voidbase-cloud/voidbase": `^${o.version}` },
        },
        null,
        2,
      )}\n`,
    );
    wrote.push("package.json");
  }
  return wrote;
}

/** the declaration file, written by whichever caller has the scaffold helper to hand */
export function writeSecretsDeclaration(dir: string, contents: string): boolean {
  const p = join(dir, "pb_secrets/main.ts");
  if (existsSync(p)) return false;
  mkdirSync(join(dir, "pb_secrets"), { recursive: true });
  writeFileSync(p, contents);
  return true;
}

export function register(instance: LocalInstance): void {
  const list = readRegistry().filter((i) => i.name !== instance.name);
  list.push(instance);
  writeRegistry(list.sort((a, b) => a.name.localeCompare(b.name)));
}

export function unregister(name: string): boolean {
  const list = readRegistry();
  const left = list.filter((i) => i.name !== name);
  if (left.length === list.length) return false;
  writeRegistry(left);
  return true;
}

/** removing the directory is the destructive half, and it is always asked for separately */
export function purge(dir: string): void {
  rmSync(resolve(dir), { recursive: true, force: true });
}
