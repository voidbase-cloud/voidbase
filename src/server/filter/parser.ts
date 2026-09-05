// Parses tokens into PocketBase-style expression groups: a flat list of (join, expr) pairs,
// where expr is either a comparison or a nested group. Folding order is decided by the compiler.
import { FilterSyntaxError, tokenize, type Sign, type Token } from "./lexer";

export type Expr =
  | { kind: "cmp"; op: Sign; left: Token; right: Token }
  | { kind: "group"; items: ExprItem[] };
export interface ExprItem { join: "&&" | "||"; expr: Expr }

const OPERAND = new Set(["identifier", "text", "number", "function"]);

export function parseFilter(input: string): Expr {
  const tokens = tokenize(input);
  return parseGroup(tokens);
}

function parseGroup(tokens: Token[]): Expr {
  const items: ExprItem[] = [];
  let i = 0;
  let join: "&&" | "||" = "&&";
  let expectJoin = false;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (expectJoin) {
      if (t.type !== "join") throw new FilterSyntaxError(`expected && or || near "${t.literal}"`);
      join = t.literal as "&&" | "||";
      expectJoin = false;
      i++;
      continue;
    }
    if (t.type === "group") {
      if (!t.meta || t.meta.length === 0) throw new FilterSyntaxError("empty group");
      items.push({ join, expr: parseGroup(t.meta) });
      i++;
      expectJoin = true;
      continue;
    }
    if (!OPERAND.has(t.type)) throw new FilterSyntaxError(`unexpected token "${t.literal}"`);
    const op = tokens[i + 1];
    const right = tokens[i + 2];
    if (!op || op.type !== "sign") throw new FilterSyntaxError(`expected operator after "${t.literal}"`);
    if (!right || !OPERAND.has(right.type)) throw new FilterSyntaxError(`expected value after "${op.literal}"`);
    items.push({ join, expr: { kind: "cmp", op: op.literal as Sign, left: t, right } });
    i += 3;
    expectJoin = true;
  }
  if (!expectJoin) throw new FilterSyntaxError("incomplete expression");
  return { kind: "group", items };
}
