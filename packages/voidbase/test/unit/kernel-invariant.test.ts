// The invariant that stops the core reabsorbing what was moved out of it.
//
// The roadmap wants an instance that is "completely gutted" without plugins. As a configuration to ship that is not
// a product: the SDK and the admin panel speak one contract, and an instance answering 404 to /api/collections can
// only be tested for 404ing. As a rule about the code it is the most valuable thing in the system, because every
// microkernel dies the same way — one feature at a time creeping back into the loader, each time for a good reason.
//
// So the rule is a test rather than a mode. The kernel and the loader may not import a feature. If a plugin needs
// something the kernel has, the kernel gains a service; if the kernel needs something a plugin has, that is the
// mistake this catches.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const read = (f: string) => readFileSync(resolvePath(import.meta.dir, "../../src/server", f), "utf8");

/** what a file imports, by module specifier */
function imports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
}

// The kernel composes; it does not know what it is composing. Hono and cordis are the machinery, the manifest and
// the resolver are its own, the platform log is everywhere. Anything else is a feature leaking in.
const KERNEL_MAY_IMPORT = new Set(["cordis", "hono", "#platform/log", "./types", "./plugins/manifest", "./plugins/resolve"]);

describe("the loader knows nothing about features", () => {
  test("kernel.ts imports only the machinery", () => {
    const wrong = imports(read("kernel.ts")).filter((i) => !KERNEL_MAY_IMPORT.has(i));
    expect(wrong).toEqual([]);
  });

  test("the resolver imports only manifests and the interface list", () => {
    const allowed = new Set(["./manifest", "../interfaces"]);
    const wrong = imports(read("plugins/resolve.ts")).filter((i) => !allowed.has(i));
    expect(wrong).toEqual([]);
  });

  test("a manifest is data: it imports nothing that runs", () => {
    const wrong = imports(read("plugins/manifest.ts")).filter((i) => !i.startsWith("../kernel"));
    expect(wrong).toEqual([]);
  });
});

describe("the interfaces are the contract, and the list is closed", () => {
  test("every interface in KNOWN has a type behind it", () => {
    const source = read("interfaces/index.ts");
    const known = [...source.matchAll(/"([a-z-]+@\d+)"/g)].map((m) => m[1]!);
    const declared = [...source.matchAll(/^\s+"([a-z-]+@\d+)":/gm)].map((m) => m[1]!);
    for (const name of new Set(known)) {
      if (name.includes("@")) expect(declared).toContain(name);
    }
  });

  test("an interface name carries its major version, so a bump is a different interface", () => {
    const source = read("interfaces/index.ts");
    const names = [...source.matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]!);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]*@\d+$/);
  });
});
