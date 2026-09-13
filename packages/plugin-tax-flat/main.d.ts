import type { Tax, TaxLine } from "@voidbase-cloud/voidbase/interfaces";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
export declare const TAX_RATE_VAR = "VOIDBASE_TAX_RATE";
/** the percentage these bindings carry: `20`, `7.5`, or 0 when it is unset, negative or not a number */
export declare function taxRate(env?: object): number;
/** what these items owe at this instance's rate: one line, or none at all when the rate is zero */
export declare function taxQuote(env: object | undefined, items: {
    quantity: number;
    unitPrice: number;
}[]): {
    lines: TaxLine[];
    total: number;
};
export declare const tax: Tax;
/** what `/api/plugins` says about it: the rate this instance charges */
export declare const taxFlatInfo: (env?: object) => {
    rate: number;
};
/** the shipped plugin: one percentage, provided as `tax@1` */
declare const taxFlat: Omit<Plugin, "manifest"> & {
    tax: Tax;
};
export default taxFlat;
