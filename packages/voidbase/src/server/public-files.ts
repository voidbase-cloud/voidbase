// pb_public from the admin panel (voidbase-stories pb-public.feature): what an instance serves at / and where it came
// from. On a vanilla instance, which holds its own files, the panel uploads into it and the instance serves the upload
// at once; on an extended one the files are the repository's, and the panel lists them and changes none of them.
//
// This module is the part both runtimes agree on: the shape of the platform's pb_public and what counts as a path
// inside it. The files themselves are the platform's: on Bun the folder `voidbase serve` serves
// (src/node/public-files.ts); a Worker serves pb_public from the assets it was deployed with, which a request cannot
// write, so it has none.

export interface PublicFiles {
  /** every file under pb_public, by path relative to it */
  list(): { path: string; size: number }[];
  /** one file, by a path publicPath accepts; its directories are made */
  write(path: string, bytes: Uint8Array): void;
}

/** a path inside pb_public, without a leading slash, or null for one that is empty, escapes it or is ambiguous */
export function publicPath(raw: string): string | null {
  const p = String(raw ?? "").replace(/^\/+/, "");
  if (!p || p.includes("\\") || p.includes("\0")) return null;
  if (p.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return p;
}
