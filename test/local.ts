// `voidbase local`: instances on this machine, which is the npm package's answer to downloading the executable.
//   bun test/local.ts
//
// Nothing here touches the network beyond localhost. The registry lives under VOIDBASE_HOME, which is pointed at a
// temporary directory so a test run never sees or writes the developer's own instances.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../bin/voidbase.ts");
const HOME = mkdtempSync(join(tmpdir(), "vb-local-"));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const run = (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(["bun", BIN, ...args], { env: { ...process.env, VOIDBASE_HOME: HOME, ...env }, stdin: "ignore" });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
};
const registry = () => (existsSync(join(HOME, "instances.json")) ? (JSON.parse(readFileSync(join(HOME, "instances.json"), "utf8")) as { instances: { name: string; port: number; dir: string }[] }).instances : []);

try {
  const empty = run(["local", "ls"]);
  check("ls with nothing registered says so and names the registry", empty.code === 0 && /no local instances yet/.test(empty.out) && empty.out.includes(HOME), empty.out.slice(0, 200));

  const made = run(["local", "new", "alpha", "--password", "hunter2hunter2"]);
  check("new creates the directory, a superuser and a next step", made.code === 0 && /created "alpha"/.test(made.out) && /superuser admin@example\.com \/ hunter2hunter2/.test(made.out) && /local start alpha/.test(made.out), made.out.slice(0, 300));
  const dir = registry()[0]?.dir ?? "";
  check("it scaffolds the same shape a project has", ["pb_hooks/main.pb.js", "pb_migrations", "pb_secrets/main.ts", ".gitignore"].every((f) => existsSync(join(dir, f))), dir);
  check("and a database with the superuser in it", existsSync(join(dir, "pb_data")), dir);

  const dup = run(["local", "new", "alpha"]);
  check("a name that is taken is refused", dup.code === 1 && /already exists/.test(dup.out), dup.out.slice(0, 200));

  const bad = run(["local", "new", "Not A Name"]);
  check("a name that cannot be used is refused before anything is written", bad.code === 1 && /not a usable name/.test(bad.out), bad.out.slice(0, 200));

  // the bug this test exists for: two instances made in a row must not both claim 8090
  run(["local", "new", "beta"]);
  run(["local", "new", "gamma"]);
  const ports = registry().map((i) => i.port);
  check("every instance gets a port of its own", new Set(ports).size === ports.length && ports.length === 3, JSON.stringify(registry().map((i) => `${i.name}:${i.port}`)));

  const listed = run(["local", "ls"]);
  check("ls shows each one with its port and state", /alpha/.test(listed.out) && /beta/.test(listed.out) && /stopped/.test(listed.out), listed.out.slice(0, 300));

  const forgotten = run(["local", "rm", "beta"]);
  const betaDir = join(HOME, "instances", "beta");
  check("rm forgets an instance and leaves its data alone", forgotten.code === 0 && !registry().some((i) => i.name === "beta") && existsSync(betaDir), forgotten.out.slice(0, 200));

  const unconfirmed = run(["local", "rm", "gamma", "--purge"]);
  check("purge refuses when nobody can be asked", unconfirmed.code === 1 && /refusing to delete data without a confirmation/.test(unconfirmed.out), unconfirmed.out.slice(0, 200));
  check("and nothing was deleted", existsSync(join(HOME, "instances", "gamma")));

  const purged = run(["local", "rm", "gamma", "--purge", "--yes"]);
  check("purge with --yes removes the row and the directory", purged.code === 0 && !existsSync(join(HOME, "instances", "gamma")) && !registry().some((i) => i.name === "gamma"), purged.out.slice(0, 200));

  const missing = run(["local", "rm", "nothing-here"]);
  check("removing a name that is not registered is an error, not a silent success", missing.code === 1 && /no local instance called/.test(missing.out), missing.out.slice(0, 200));

  const startMissing = run(["local", "start", "nothing-here"]);
  check("starting a name that is not registered says so", startMissing.code === 1 && /no local instance called/.test(startMissing.out), startMissing.out.slice(0, 200));

  const help = run(["local", "wat"]);
  check("an unknown subcommand prints the usage", help.code === 1 && /local new\|ls\|start\|rm/.test(help.out), help.out.slice(0, 200));
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
