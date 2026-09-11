// One rate of tax on everything, so a shop works the minute it is installed.
//
// `commerce` requires `tax@1` and not this plugin, which is the whole point of putting the interface between them:
// a shop that owes VAT per country, or that has to call Avalara or TaxJar, installs something else providing
// `tax@1` and commerce never learns that anything changed. What this one does is the part every shop needs before
// it needs any of that: one percentage, `VOIDBASE_TAX_RATE`, applied to the line items, as one line labelled with
// the rate. Unset or zero is a shop that charges no tax, which is a valid shop and not an error.
//
// Amounts are integers in the currency's minor unit, like the payments plugin's, and the rounding is half away
// from zero on the order's subtotal rather than per line: rounding each line and adding them up is how a total
// ends up a penny away from what the customer was shown.
import { env as voidEnv } from "#platform/env";
import type { Bindings } from "../types";
import type { Tax, TaxLine } from "../interfaces";
import { serve, type Kernel } from "../kernel";
import type { Plugin } from "./manifest";

export const TAX_RATE_VAR = "VOIDBASE_TAX_RATE";

/** a knob as these bindings carry it: the request env first, the runtime env second, like every other plugin's */
const knob = (env: object | undefined, name: string): string =>
  String((env as Record<string, unknown> | undefined)?.[name] ?? (voidEnv as Record<string, unknown>)[name] ?? "").trim();

/** the percentage these bindings carry: `20`, `7.5`, or 0 when it is unset, negative or not a number */
export function taxRate(env?: object): number {
  const raw = knob(env, TAX_RATE_VAR);
  if (!raw) return 0;
  const n = Number(raw.endsWith("%") ? raw.slice(0, -1) : raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** half away from zero, which is what a till does and what `Math.round` does not do for negatives */
const round = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

/** what these items owe at this instance's rate: one line, or none at all when the rate is zero */
export function taxQuote(env: object | undefined, items: { quantity: number; unitPrice: number }[]): { lines: TaxLine[]; total: number } {
  const rate = taxRate(env);
  const subtotal = items.reduce((n, i) => n + Math.trunc(i.unitPrice) * Math.trunc(i.quantity), 0);
  if (!rate || !subtotal) return { lines: [], total: 0 };
  const amount = round((subtotal * rate) / 100);
  return { lines: [{ label: `Tax (${rate}%)`, amount }], total: amount };
}

export const tax: Tax = {
  async quote(env: Bindings, o) {
    return taxQuote(env, o.items);
  },
};

/** what `/api/plugins` says about it: the rate this instance charges */
export const taxFlatInfo = (env?: object): { rate: number } => ({ rate: taxRate(env) });

/** the shipped plugin: one percentage, provided as `tax@1` */
export const taxFlat: Plugin & { tax: Tax } = {
  manifest: { name: "tax-flat", version: "0.1.0", tier: "official", voidbase: "*", provides: ["tax@1"] },
  info: (env) => taxFlatInfo(env),
  tax,
  apply(ctx: Kernel) {
    serve<Tax>(ctx, "tax@1", tax);
  },
};
