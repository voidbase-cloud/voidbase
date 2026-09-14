// Whether a rule admits a caller before any record is in question: what a document scoped to that caller shows
// (voidbase-stories b-binary-extended.feature: "A vendor fetching their own schema"). Each comparison that reads only
// who is asking (`@request.auth.*`, the date macros, literals) is decided with one query, the same SQL the records API
// runs; one that reads a record's fields, another collection or the request itself can only be judged per record or per
// call. The parts are folded the way the compiler folds them, left to right, so `@request.auth.vendor = "acme" &&
// total >= 0` is "no" for every other vendor and "per-record" for acme.
import { parseFilter, type Expr } from "./parser";
import type { Token } from "./lexer";
import { compileExpr, type AuthInfo, type CompileOptions } from "./compile";
import type { Collection } from "../collections/model";

export type RuleVerdict = "yes" | "no" | "per-record";

/** the identifiers a comparison reads, function arguments included */
function identifiers(e: Expr & { kind: "cmp" }): string[] {
  const out: string[] = [];
  const token = (t: Token) => { if (t.type === "identifier") out.push(t.literal); for (const m of t.meta ?? []) token(m); };
  token(e.left); token(e.right);
  return out;
}

const LITERALS = new Set(["null", "true", "false"]);
/** the caller alone, or a macro: nothing a record or the call itself carries */
const aboutTheCaller = (name: string) => LITERALS.has(name.toLowerCase()) || name.startsWith("@request.auth.") || (name.startsWith("@") && !name.startsWith("@request.") && !name.startsWith("@collection."));

const and = (a: RuleVerdict, b: RuleVerdict): RuleVerdict => (a === "no" || b === "no" ? "no" : a === "yes" && b === "yes" ? "yes" : "per-record");
const or = (a: RuleVerdict, b: RuleVerdict): RuleVerdict => (a === "yes" || b === "yes" ? "yes" : a === "no" && b === "no" ? "no" : "per-record");

export async function decideRule(o: { db: D1Database; collections: Map<string, Collection>; collection: Collection; rule: string | null; auth: AuthInfo | null }): Promise<RuleVerdict> {
  if (o.rule === null) return "no";
  if (o.rule.trim() === "") return "yes";
  let ast: Expr;
  try { ast = parseFilter(o.rule); } catch { return "per-record"; }
  const opts: CompileOptions = { base: o.collection, collections: o.collections, request: { auth: o.auth, method: "GET", query: {}, headers: {}, body: {}, context: "default" }, allowHiddenFields: true };

  async function decide(e: Expr): Promise<RuleVerdict> {
    if (e.kind === "cmp") {
      if (!identifiers(e).every(aboutTheCaller)) return "per-record";
      try {
        const compiled = compileExpr(e, opts);
        // a nested @request.auth path joins the auth collection, which a query with no FROM cannot hold
        if (compiled.joins.length) return "per-record";
        const row = await o.db.prepare(`SELECT CASE WHEN (${compiled.where}) THEN 1 ELSE 0 END AS ok`).bind(...compiled.params).first<{ ok: number }>();
        return row?.ok ? "yes" : "no";
      } catch { return "per-record"; }
    }
    let verdict: RuleVerdict | undefined;
    for (const item of e.items) {
      const v = await decide(item.expr);
      verdict = verdict === undefined ? v : item.join === "&&" ? and(verdict, v) : or(verdict, v);
    }
    return verdict ?? "yes";
  }
  return decide(ast);
}
