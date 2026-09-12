import { test, expect } from "bun:test";
import { parseRedirects } from "../../src/node/cloud-init";
import { redirectRule } from "../../src/node/zone-redirects";

const file = `# roles per hostname
https://www.example.com/*   https://example.com/:splat   301!
https://api.example.com/    /_/                          302
https://api.example.com/docs/*  https://example.com/docs/:splat
/old   /new
/skip  /x  200
`;

test("parseRedirects: hosts split off, defaults, 200 rules ignored", () => {
  const r = parseRedirects(file);
  expect(r.map((x) => [x.host, x.path, x.to, x.status])).toEqual([
    ["www.example.com", "/*", "https://example.com/:splat", 301],
    ["api.example.com", "/", "/_/", 302],
    ["api.example.com", "/docs/*", "https://example.com/docs/:splat", 302],
    [undefined, "/old", "/new", 302],
  ]);
});

test("redirectRule: whole-host splat, exact path, prefix splat, relative targets made absolute", () => {
  const [www, root, docs] = parseRedirects(file);
  const a = redirectRule("site", www!) as { expression: string; action_parameters: { from_value: { target_url: { expression?: string; value?: string }; status_code: number } } };
  expect(a.expression).toBe('(http.host eq "www.example.com")');
  expect(a.action_parameters.from_value.target_url.expression).toBe('concat("https://example.com", http.request.uri.path)');
  expect(a.action_parameters.from_value.status_code).toBe(301);
  const b = redirectRule("site", root!) as typeof a;
  expect(b.expression).toBe('(http.host eq "api.example.com" and http.request.uri.path eq "/")');
  expect(b.action_parameters.from_value.target_url.value).toBe("https://api.example.com/_/");
  const c = redirectRule("site", docs!) as typeof a & { description: string };
  expect(c.expression).toBe('(http.host eq "api.example.com" and starts_with(http.request.uri.path, "/docs/"))');
  expect(c.action_parameters.from_value.target_url.expression).toBe('concat("https://example.com/docs", substring(http.request.uri.path, 5))');
  expect(c.description).toBe("voidbase:site:https://api.example.com/docs/*");
});
