import type Client from "@/Client";
import type { BeforeSendResult } from "@/Client";
import type { ClientResponseError } from "@/ClientResponseError";
import type { SendOptions } from "@/tools/options";

/**
 * A hook of the `client.hooks.beforeSend` list.
 *
 * Called with the url and the request options right before the fetch
 * request, after the `client.beforeSend` property (if set). It may modify
 * the options in place, or return `{ url, options }` to replace them.
 */
export type BeforeSendHook = (
    url: string,
    options: SendOptions,
) => BeforeSendResult | void | Promise<BeforeSendResult | void>;

/**
 * A hook of the `client.hooks.afterSend` list.
 *
 * Called with the response and its parsed data after the `client.afterSend`
 * property (if set). What it returns (or resolves to) becomes the data the
 * next hook sees and, after the last one, the data the caller receives.
 */
export type AfterSendHook = (response: Response, data: any, options: SendOptions) => any;

/**
 * The request an `onError` hook is told about: the final url and the
 * options as they were passed to fetch.
 */
export interface FailedRequest {
    url: string;
    options: SendOptions;
}

/**
 * A hook of the `client.hooks.onError` list.
 *
 * Called with the error `client.send()` is about to throw, always a
 * `ClientResponseError` (a network failure has `status` 0 and the thrown
 * error as `originalError`; a 4xx/5xx reply has its status and data).
 *
 * Returning `undefined` passes the error on to the next hook and, after the
 * last one, to the caller. Returning a `Response` (anything with a `json()`
 * method and a numeric `status`) recovers the request with that reply, which
 * is parsed as the original one would have been. Returning anything else
 * recovers with that value as the resolved data.
 */
export type OnErrorHook = (err: ClientResponseError, request: FailedRequest) => any;

/**
 * An ordered list of hook functions.
 *
 * `add` appends and returns a function that removes what it added, so a
 * plugin can undo its installation without keeping a reference around.
 * Iteration walks a snapshot, so a hook may remove itself while it runs.
 */
export class HookList<F extends (...args: any[]) => any> {
    private fns: Array<F> = [];

    /**
     * Appends the hook and returns its remover.
     */
    add(fn: F): () => void {
        this.fns.push(fn);

        return () => this.remove(fn);
    }

    /**
     * Removes the hook (the first occurrence, if added more than once).
     */
    remove(fn: F): void {
        const i = this.fns.indexOf(fn);
        if (i >= 0) {
            this.fns.splice(i, 1);
        }
    }

    /**
     * Removes every hook.
     */
    clear(): void {
        this.fns = [];
    }

    /**
     * The number of hooks in the list.
     */
    get size(): number {
        return this.fns.length;
    }

    /**
     * The hooks in call order (a copy).
     */
    list(): Array<F> {
        return this.fns.slice();
    }

    [Symbol.iterator](): Iterator<F> {
        return this.fns.slice()[Symbol.iterator]();
    }
}

/**
 * The hook lists of a client, on the request path of every `client.send()`.
 */
export interface ClientHooks {
    readonly beforeSend: HookList<BeforeSendHook>;
    readonly afterSend: HookList<AfterSendHook>;
    readonly onError: HookList<OnErrorHook>;
}

/**
 * A client plugin.
 *
 * `install` is called once by `client.use(plugin)` with the client; it may
 * add hooks, wrap methods or attach state to the client, and may return a
 * function that undoes all of that, which `client.unuse(name)` calls.
 *
 * The type parameter names what the plugin attaches to the client, so that
 * `client.use(plugin)` answers the client with that addition typed; a plugin
 * that attaches nothing leaves it at its default.
 */
export interface Plugin<Ext extends object = {}> {
    /**
     * The name the plugin is installed under; one installation per name.
     */
    name: string;

    /**
     * Installs the plugin on the client. The returned function, if any,
     * uninstalls it.
     */
    install(client: Client): void | (() => void);

    /**
     * Never set at runtime: it carries the type of what `install` attaches
     * to the client, so that `client.use(plugin)` can answer that type.
     */
    readonly __ext?: Ext;
}
