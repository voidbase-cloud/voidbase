import type { Shipping, ShippingRate } from "@voidbase-cloud/voidbase/interfaces";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
export declare const SHIPPING_FLAT_VAR = "VOIDBASE_SHIPPING_FLAT";
export declare const SHIPPING_FREE_OVER_VAR = "VOIDBASE_SHIPPING_FREE_OVER";
/** the one rate's id, which a checkout may name and which never changes */
export declare const FLAT_RATE_ID = "flat";
export declare const flatAmount: (env?: object) => number;
export declare const freeOver: (env?: object) => number;
/** the one rate these items get: the flat amount, or nothing to pay once the subtotal reaches the threshold */
export declare function flatRates(env: object | undefined, items: {
    quantity: number;
    unitPrice: number;
}[]): ShippingRate[];
export declare const shipping: Shipping;
/** what `/api/plugins` says about it: the amount and the threshold this instance is set to */
export declare const shippingFlatInfo: (env?: object) => {
    flat: number;
    freeOver: number;
};
/** the shipped plugin: one rate, provided as `shipping@1` */
declare const shippingFlat: Omit<Plugin, "manifest"> & {
    shipping: Shipping;
};
export default shippingFlat;
