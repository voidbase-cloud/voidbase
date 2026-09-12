// Tokenizer for PocketBase's filter language (fexpr grammar).
export type TokenType = "identifier" | "text" | "number" | "sign" | "join" | "group" | "function";
export interface Token {
  type: TokenType;
  literal: string;
  // group: nested tokens; function: argument tokens
  meta?: Token[];
}

export const SIGNS = ["?!=", "?!~", "?>=", "?<=", "?=", "?~", "?>", "?<", "!=", "!~", ">=", "<=", "=", "~", ">", "<"] as const;
export type Sign = (typeof SIGNS)[number];

export class FilterSyntaxError extends Error {}

const isIdentStart = (c: string) => /[A-Za-z_@#]/.test(c);
const isIdentChar = (c: string) => /[\w.:@]/.test(c);

export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "/" && input[i + 1] === "/") { while (i < n && input[i] !== "\n") i++; continue; }
    if (c === "(") {
      const end = matchParen(input, i);
      out.push({ type: "group", literal: input.slice(i + 1, end), meta: tokenize(input.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (c === "&" && input[i + 1] === "&") { out.push({ type: "join", literal: "&&" }); i += 2; continue; }
    if (c === "|" && input[i + 1] === "|") { out.push({ type: "join", literal: "||" }); i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = "";
      while (j < n && input[j] !== q) {
        if (input[j] === "\\" && j + 1 < n) { s += input[j + 1]; j += 2; continue; }
        s += input[j]; j++;
      }
      if (j >= n) throw new FilterSyntaxError("unterminated string");
      out.push({ type: "text", literal: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(input[j]!)) j++;
      out.push({ type: "number", literal: input.slice(i, j) });
      i = j;
      continue;
    }
    const sign = SIGNS.find((s) => input.startsWith(s, i));
    if (sign) { out.push({ type: "sign", literal: sign }); i += sign.length; continue; }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(input[j]!)) j++;
      const name = input.slice(i, j);
      if (input[j] === "(") {
        const end = matchParen(input, j);
        const args = splitArgs(input.slice(j + 1, end)).map((a) => {
          const t = tokenize(a);
          if (t.length !== 1) throw new FilterSyntaxError(`invalid function argument "${a}"`);
          return t[0]!;
        });
        out.push({ type: "function", literal: name, meta: args });
        i = end + 1;
        continue;
      }
      out.push({ type: "identifier", literal: name });
      i = j;
      continue;
    }
    throw new FilterSyntaxError(`unexpected character "${c}" at ${i}`);
  }
  return out;
}

function matchParen(input: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < input.length; i++) {
    const c = input[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  throw new FilterSyntaxError("unbalanced parentheses");
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { cur += c; if (c === "\\") { cur += s[++i] ?? ""; } else if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
