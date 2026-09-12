// One shipping rate, free over a threshold, so a shop can take an order the day it is installed.
//
// The twin of `tax-flat`, and there for the same reason: `commerce` requires `shipping@1`, not this plugin, so a
// shop that needs real rates installs something that calls EasyPost, Shippo or a carrier's own API and commerce
// does not change. This one answers one rate from two knobs: `VOIDBASE_SHIPPING_FLAT`, the amount in the
// currency's minor unit, and `VOIDBASE_SHIPPING_FREE_OVER`, the order subtotal at or above which that amount
// becomes zero. Neither set is a shop that ships free, which is a working shop and not an error.
import { env as voidEnv } from "#platform/env";
import type { Bindings } from "../types";
import type { Shipping, ShippingRate } from "../interfaces";
import { serve, type Kernel } from "../kernel";
import type { Plugin } from "./manifest";

export const SHIPPING_FLAT_VAR = "VOIDBASE_SHIPPING_FLAT";
export const SHIPPING_FREE_OVER_VAR = "VOIDBASE_SHIPPING_FREE_OVER";
/** the one rate's id, which a checkout may name and which never changes */
export const FLAT_RATE_ID = "flat";

const knob = (env: object | undefined, name: string): string =>
  String((env as Record<string, unknown> | undefined)?.[name] ?? (voidEnv as Record<string, unknown>)[name] ?? "").trim();

/** a whole number of minor units, or 0 when the knob is unset, negative or not a number */
const amountKnob = (env: object | undefined, name: string): number => {
  const n = Number(knob(env, name));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

export const flatAmount = (env?: object): number => amountKnob(env, SHIPPING_FLAT_VAR);
export const freeOver = (env?: object): number => amountKnob(env, SHIPPING_FREE_OVER_VAR);

/** the one rate these items get: the flat amount, or nothing to pay once the subtotal reaches the threshold */
export function flatRates(env: object | undefined, items: { quantity: number; unitPrice: number }[]): ShippingRate[] {
  const subtotal = items.reduce((n, i) => n + Math.trunc(i.unitPrice) * Math.trunc(i.quantity), 0);
  const threshold = freeOver(env);
  const amount = threshold > 0 && subtotal >= threshold ? 0 : flatAmount(env);
  return [{ id: FLAT_RATE_ID, label: amount === 0 ? "Free shipping" : "Standard shipping", amount }];
}

export const shipping: Shipping = {
  async rates(env: Bindings, o) {
    return flatRates(env, o.items);
  },
};

/** what `/api/plugins` says about it: the amount and the threshold this instance is set to */
export const shippingFlatInfo = (env?: object): { flat: number; freeOver: number } => ({ flat: flatAmount(env), freeOver: freeOver(env) });

/** the shipped plugin: one rate, provided as `shipping@1` */
export const shippingFlat: Plugin & { shipping: Shipping } = {
  manifest: { name: "shipping-flat", version: "0.1.0", tier: "official", voidbase: "*", provides: ["shipping@1"] },
  info: (env) => shippingFlatInfo(env),
  shipping,
  apply(ctx: Kernel) {
    serve<Shipping>(ctx, "shipping@1", shipping);
  },
};
