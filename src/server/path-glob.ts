// One matcher for a request path against something somebody wrote: the hook router's patterns (`routerAdd`,
// src/server/hooks/index.ts) and the response policy's per-route Content-Security-Policy globs
// (`VOIDBASE_CSP_ROUTES`, src/server/response-policy.ts). It lives here so there is one of it rather than one per
// caller, which is the only way a glob written for one place reads the same in the other.
//
// The shape is Go's ServeMux as PocketBase's hooks use it, segment by segment: a literal segment matches itself,
// `:name` matches one segment and is captured under that name, `*` matches the rest of the path, and a trailing
// slash is optional. A `_redirects` source and Cloudflare's `run_worker_first` globs (`/api`, `/api/*`) are
// written the same way, so `/api/files/*` means there what it means here.
export interface PathPattern {
  /** the whole path matched, anchored, with a trailing slash optional */
  re: RegExp;
  /** the `:name` segments, in the order the expression captures them */
  keys: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the pattern compiled: what it matches a path with, and the `:name` segments it captures */
export function pathPattern(pattern: string): PathPattern {
  const keys: string[] = [];
  const src = pattern.split("/").map((seg) => {
    if (seg === "*") return ".*";
    if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
    return escape(seg);
  }).join("/");
  return { re: new RegExp(`^${src}/?$`), keys };
}

/** how specific a pattern is, the order Go's ServeMux picks in: literal segments beat params beat wildcards */
export const pathScore = (pattern: string): number =>
  (pattern.includes("*") ? 0 : 1000) + pattern.split("/").filter((s) => s && !s.startsWith(":")).length * 10 + pattern.split("/").length;

// a policy is matched on every response, so the compiled form is kept rather than rebuilt per request
const compiled = new Map<string, PathPattern>();

/** whether the path matches the pattern */
export function pathMatches(pattern: string, path: string): boolean {
  let p = compiled.get(pattern);
  if (!p) { p = pathPattern(pattern); if (compiled.size > 200) compiled.clear(); compiled.set(pattern, p); }
  return p.re.test(path);
}
