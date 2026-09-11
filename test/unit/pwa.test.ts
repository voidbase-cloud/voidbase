// The pure parts of the adapter's `pwa` option (src/adapter/pwa.ts): the manifest's defaults, the tags added to a
// page, the precache list and its version, and the shape of the generated service worker. The whole pass, icons
// included, runs in test/adapter.ts against the fixture app.
import { describe as group, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateManifest, generateServiceWorker, injectHead, precacheList, versionOf } from "../../src/adapter/pwa";

const app = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "vb-pwa-"));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), body); }
  return root;
};

group("manifest", () => {
  test("defaults come from void.json's head, then package.json, and the options win", () => {
    const root = app({
      "void.json": JSON.stringify({ head: { title: "Notes", meta: [{ name: "description", content: "Keep notes" }, { name: "theme-color", content: "#112233" }] } }),
      "package.json": JSON.stringify({ name: "notes-app" }),
    });
    const m = generateManifest(root, {}, []);
    expect(m).toEqual({ name: "Notes", short_name: "Notes", description: "Keep notes", start_url: "/", scope: "/", display: "standalone", theme_color: "#112233", background_color: "#112233", icons: [] });
    const over = generateManifest(root, { name: "Notes!", shortName: "N", themeColor: "#000", backgroundColor: "#fff", start: "/app", scope: "/app/" }, []);
    expect(over).toMatchObject({ name: "Notes!", short_name: "N", theme_color: "#000", background_color: "#fff", start_url: "/app", scope: "/app/" });
  });
  test("without a head the name falls back to package.json, and undefined fields are left out", () => {
    const root = app({ "package.json": JSON.stringify({ name: "bare" }) });
    const m = generateManifest(root, {}, []);
    expect(m.name).toBe("bare");
    expect("description" in m).toBe(false);
    expect("theme_color" in m).toBe(false);
  });
});

group("head tags", () => {
  test("adds the manifest link and the theme colour before </head>", () => {
    const html = injectHead("<!doctype html><html><head><title>x</title></head><body></body></html>", "#123456");
    expect(html).toBe('<!doctype html><html><head><title>x</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#123456"></head><body></body></html>');
  });
  test("a page with no head element gets the tags right after the doctype", () => {
    const html = injectHead('<!doctype html><meta charset="utf-8"><h1>x</h1>', "#123456");
    expect(html.startsWith('<!doctype html><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#123456"><meta charset="utf-8">')).toBe(true);
  });
  test("what the page already has is kept, and the pass is idempotent", () => {
    const page = '<html><head><link rel="manifest" href="/mine.json"><meta name="theme-color" content="#000"></head></html>';
    expect(injectHead(page, "#123456")).toBe(page);
    const once = injectHead("<html><head></head></html>", "#123456");
    expect(injectHead(once, "#123456")).toBe(once);
    expect(injectHead("<html><head></head></html>")).toBe('<html><head><link rel="manifest" href="/manifest.webmanifest"></head></html>');
  });
});

group("precache and version", () => {
  test("pages by their URL, hashed assets, the extra list; the panel, dotfiles, the 404 shell and plain files are left out", () => {
    const pub = app({
      "index.html": "<h1>a</h1>", "404.html": "<h1>a</h1>", "faq.html": "<h1>faq</h1>", "docs/index.html": "<h1>docs</h1>",
      "assets/index-Ab12Cd34.js": "x", "robots.txt": "User-agent: *", "fonts/inter.woff2": "f", ".assetsignore": "", "_/index.html": "panel", "sw.js": "", "manifest.webmanifest": "{}",
    });
    expect(precacheList(pub, ["fonts/inter.woff2"])).toEqual(["/", "/assets/index-Ab12Cd34.js", "/docs/", "/faq.html", "/fonts/inter.woff2"]);
    expect(() => precacheList(pub, ["/fonts/nope.woff2"])).toThrow(/pwa\.precache names "\/fonts\/nope\.woff2"/);
  });
  test("the version follows the shell's contents", () => {
    const pub = app({ "index.html": "<h1>a</h1>", "assets/app-Ab12Cd34.js": "x" });
    const list = precacheList(pub);
    const v1 = versionOf(pub, list);
    expect(v1).toMatch(/^[0-9a-f]{12}$/);
    expect(versionOf(pub, list)).toBe(v1);
    writeFileSync(join(pub, "index.html"), "<h1>b</h1>");
    expect(versionOf(pub, list)).not.toBe(v1);
  });
});

group("service worker", () => {
  const sw = generateServiceWorker({ version: "abc123abc123", precache: ["/", "/assets/app-Ab12Cd34.js"], start: "/" });
  test("carries the version, the list and the three messages, and is dependency free", () => {
    expect(sw).toContain('const VERSION = "abc123abc123"');
    expect(sw).toContain('  "/",\n  "/assets/app-Ab12Cd34.js",\n');
    expect(sw).toContain('"SKIP_WAITING"');
    expect(sw).toContain('{ type: "UPDATED", version: VERSION }');
    expect(sw).toContain('"UNREGISTER"');
    expect(sw).toContain('{ type: "UNREGISTERED" }');
    expect(sw).not.toMatch(/\bimport\b|\brequire\(/);
  });
  test("does not skip waiting on install; navigations are network first, assets cache first, the API and the panel untouched", () => {
    const install = sw.split('addEventListener("install"')[1]!.split("addEventListener(")[0]!;
    expect(install).not.toContain("skipWaiting");
    expect(sw).toContain('const NEVER = ["/api/", "/_/"]');
    expect(sw).toContain('if (request.mode === "navigate") { event.respondWith(networkFirst(request, url)); return; }');
    expect(sw).toContain("url.pathname.startsWith(ASSETS) || PRECACHE.includes(url.pathname)");
  });
});
