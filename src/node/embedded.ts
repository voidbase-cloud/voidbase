// What a standalone executable carries that a checkout reads from disk: the version, the system migrations, the
// hooks typings and the admin panel (zipped). scripts/build-exe.ts writes src/node/embedded.generated.json right
// before compiling; in a checkout the file does not exist and every reader falls back to the package directory.
export interface Embedded { version: string; migrations: Record<string, string>; typesDts: string; panel: { version: string; zipBase64: string } | null }

let cached: Embedded | null | undefined;
export async function embedded(): Promise<Embedded | null> {
  if (cached !== undefined) return cached;
  try { cached = ((await import("./embedded.generated.json", { with: { type: "json" } })) as { default: Embedded }).default; } catch { cached = null; }
  return cached;
}

// Bun mounts a compiled executable's modules under a virtual root ("/$bunfs/root", "B:\~BUN\root" on Windows)
export const isExecutable = (): boolean => /\$bunfs|~BUN/.test(import.meta.dir);
