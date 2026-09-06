// The `fields` query param: comma separated paths with optional modifiers (`body:excerpt(200,true)`), `*` wildcard.
interface Node { children: Map<string, Node>; modifier?: (v: unknown) => unknown; leaf: boolean }

export function parseFields(raw: string): Node | null {
  const root: Node = { children: new Map(), leaf: false };
  const parts = splitTopLevel(raw).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^([^:]+)(?::(\w+)\(([^)]*)\))?$/.exec(part);
    if (!m) throw new Error(`invalid fields expression "${part}"`);
    const path = m[1]!.split(".").map((s) => s.trim()).filter(Boolean);
    let node = root;
    for (const seg of path) {
      let next = node.children.get(seg);
      if (!next) { next = { children: new Map(), leaf: false }; node.children.set(seg, next); }
      node = next;
    }
    node.leaf = true;
    if (m[2] === "excerpt") {
      const args = (m[3] ?? "").split(",").map((s) => s.trim());
      const max = Number(args[0]) || 0;
      const ellipsis = args[1] === "true";
      node.modifier = (v) => (typeof v === "string" ? excerpt(v, max, ellipsis) : v);
    } else if (m[2]) throw new Error(`unknown fields modifier "${m[2]}"`);
  }
  return root;
}

export function pick(data: unknown, node: Node | null): unknown {
  if (!node) return data;
  if (Array.isArray(data)) return data.map((d) => pick(d, node));
  if (!data || typeof data !== "object") return data;
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const star = node.children.get("*");
  // tools/picker decodes into map[string]any, so Go serializes the picked object with sorted keys
  for (const [k, v] of Object.entries(src).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const child = node.children.get(k) ?? star;
    if (!child) continue;
    const value = child.children.size ? pick(v, child) : sortDeep(v);
    out[k] = child.modifier ? child.modifier(value) : value;
  }
  return out;
}

// the whole picked document went through map[string]any in Go, so nested objects come back key-sorted too
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortDeep(x)]));
}

const INLINE = new Set(["a", "abbr", "acronym", "b", "bdo", "big", "br", "button", "cite", "code", "dfn", "em", "i", "img", "input", "kbd", "label", "map", "object", "output", "q", "samp", "select", "small", "span", "strong", "sub", "sup", "textarea", "time", "tt", "u", "var", "video"]);

// tools/picker/excerpt_modifier.go: strip tags (block tags become spaces), collapse whitespace, cut to max, optional "...".
export function excerpt(html: string, max: number, ellipsis: boolean): string {
  let text = html.replace(/<(script|style|head|title|template)[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (_m, tag: string) => (INLINE.has(tag.toLowerCase()) ? "" : " "));
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, " ").trim();
  if (max <= 0 || [...text].length <= max) return text;
  let cut = [...text].slice(0, max).join("");
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  cut = cut.trimEnd();
  return ellipsis ? cut + "..." : cut;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
