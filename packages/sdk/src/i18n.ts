// The interface strings runtime, as a plugin: @voidbase-cloud/sdk/i18n
//
// The other half of `voidbase i18n extract`, which walks the source for
// `t("key", "default")` calls and writes `i18n/<locale>.json` (a flat
// key-to-text object, `""` for untranslated) and `i18n/keys.d.ts` (the
// `MessageKey`, `Locale` and `Messages` types). The extractor deliberately
// ships no runtime; this is it.
//
// Installed, it attaches `client.i18n`: `t(key, vars)` answers the text of
// the chosen locale (an empty one falling through to the source locale and
// then to the key itself), `setLocale(code)` changes it, persists it when
// asked and tells `onChange` listeners, and `missing()` lists the keys that
// answered themselves. The catalogues are passed in, not read from disk,
// because this runs in a browser; the application imports them from the
// files the extractor wrote.
//
// Installing also adds one `beforeSend` hook that sends `Accept-Language:
// <locale>` with every request, so the instance's `translations` plugin
// answers content in the language the interface is in.
//
// The plugin imports only types from the core package, so this entry
// carries no second copy of the client.

import type Client from "@voidbase-cloud/sdk";
import type { Plugin } from "@voidbase-cloud/sdk";

/**
 * One locale's strings: the flat key-to-text object `voidbase i18n extract`
 * writes to `i18n/<locale>.json`, where `""` is an untranslated key.
 */
export type Catalogue = { [key: string]: string };

/**
 * The catalogues by locale code, in preference order: the first is the
 * source locale, the one whose texts the calls themselves carry.
 */
export type Catalogues = { [locale: string]: Catalogue };

/**
 * What an interpolated text is filled with; a name the text does not
 * mention is ignored, and a placeholder without a value is left alone.
 */
export type I18nVars = { [name: string]: string | number | boolean | null | undefined };

/**
 * The `t` of a client, narrowed to the keys in use when the application
 * hands the `MessageKey` of its generated `i18n/keys.d.ts` to `i18n()`.
 */
export type Translate<K extends string = string> = (key: K, vars?: I18nVars) => string;

/**
 * The delimiters a placeholder is written with (default `{name}`).
 */
export interface I18nDelimiters {
    open: string;
    close: string;
}

export interface I18nOptions {
    /**
     * The strings by locale, as the application imports them from the files
     * `voidbase i18n extract` wrote. The first locale is the source one.
     */
    catalogues: Catalogues;

    /**
     * The locale to start in, which is the application's word: matched
     * against the catalogue names (exactly, then by primary subtag, so
     * "en-GB" finds "en") and kept as given when none of them matches.
     * Without it the locale is negotiated: the persisted choice, then
     * `navigator.language` and `navigator.languages`, then the first
     * catalogue, which is the source locale.
     */
    locale?: string;

    /**
     * What an empty (untranslated) or unknown key falls through to:
     * "source", the source locale's text and then the key itself, or "key",
     * the key straight away (default: "source").
     */
    fallback?: "source" | "key";

    /**
     * The placeholder delimiters of `t(key, vars)`
     * (default: `{ open: "{", close: "}" }`, aka `{name}`).
     */
    vars?: I18nDelimiters;

    /**
     * Remember the locale `setLocale` chose in localStorage, under
     * "voidbase_locale" for `true` or under the string given
     * (default: false).
     */
    persist?: boolean | string;

    /**
     * Called with every key that answered itself, once per `t` call.
     */
    onMissing?: (key: string, locale: string) => void;

    /**
     * Whether every request carries `Accept-Language: <locale>`, so that the
     * instance answers content in the interface's language (default: true).
     */
    header?: boolean;
}

/**
 * The controller attached as `client.i18n`.
 */
export interface I18nController<K extends string = string> {
    /**
     * The locale in use.
     */
    readonly locale: string;

    /**
     * The locales there are catalogues for, in the order they were given;
     * the first is the source locale.
     */
    readonly locales: Array<string>;

    /**
     * The text of the key in the locale in use, with the placeholders of
     * `vars` filled in. An empty or unknown key falls through as `fallback`
     * says and, when that leaves nothing, answers the key itself and records
     * it for `missing()`.
     *
     * It is bound to the controller, so `const { t } = client.i18n` works.
     */
    t: Translate<K>;

    /**
     * Whether the key answers a text rather than itself (following the same
     * fallback as `t`).
     */
    has(key: string): boolean;

    /**
     * Changes the locale (matched as the `locale` option is), persists it
     * when asked and calls the `onChange` listeners. Does nothing when it is
     * already the locale in use. The client's requests are untouched beyond
     * the `Accept-Language` header they carry from now on.
     */
    setLocale(code: string): void;

    /**
     * Calls `cb(locale)` after every change; the returned function stops it.
     */
    onChange(cb: (locale: string) => void): () => void;

    /**
     * The keys that answered themselves so far, in the order they were
     * first asked for.
     */
    missing(): Array<string>;
}

/**
 * A client with the i18n plugin installed (what `client.use(i18n())`
 * answers).
 */
export type I18nClient<T extends Client = Client, K extends string = string> = T & {
    i18n: I18nController<K>;
};

const PERSIST_KEY = "voidbase_locale";

const DEFAULT_DELIMITERS: I18nDelimiters = { open: "{", close: "}" };

function storage(): Storage | null {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (_) {
        return null; // access denied (a sandboxed frame, a browser with storage off)
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function primary(code: string): string {
    return code.toLowerCase().split(/[-_]/)[0];
}

/**
 * The first of the wanted codes that one of the locales answers to: the
 * same code, else one with the same primary subtag ("en-GB" finds "en", and
 * "en" finds "en-GB").
 */
function negotiate(wanted: Array<string>, locales: Array<string>): string | null {
    for (const raw of wanted) {
        const want = String(raw || "").trim();
        if (!want) {
            continue;
        }

        const exact = locales.find((l) => l.toLowerCase() === want.toLowerCase());
        if (exact) {
            return exact;
        }

        const base = locales.find((l) => primary(l) === primary(want));
        if (base) {
            return base;
        }
    }

    return null;
}

/**
 * What the browser says it prefers, the top one first.
 */
function browserLocales(): Array<string> {
    if (typeof navigator === "undefined" || !navigator) {
        return [];
    }

    const nav = navigator as any;

    return [nav.language]
        .concat(Array.isArray(nav.languages) ? nav.languages : [])
        .filter((code: any) => typeof code === "string" && code !== "");
}

class Controller<K extends string> implements I18nController<K> {
    private catalogues: Catalogues;
    private names: Array<string>;
    private current: string;
    private fallback: "source" | "key";
    private placeholder: RegExp;
    private key: string | null;
    private onMissing?: (key: string, locale: string) => void;
    private listeners: Array<(locale: string) => void> = [];
    private missed: Array<string> = [];

    constructor(options: I18nOptions) {
        this.catalogues = options.catalogues || {};
        this.names = Object.keys(this.catalogues);
        this.fallback = options.fallback === "key" ? "key" : "source";
        this.onMissing = options.onMissing;
        this.key =
            typeof options.persist === "string"
                ? options.persist
                : options.persist
                  ? PERSIST_KEY
                  : null;

        const delimiters = options.vars || DEFAULT_DELIMITERS;
        this.placeholder = new RegExp(
            escapeRegExp(delimiters.open) +
                "\\s*([\\w.$-]+)\\s*" +
                escapeRegExp(delimiters.close),
            "g",
        );

        // the explicit locale, which is the application's word; without one
        // the persisted choice, then the browser's, then the source locale
        if (options.locale) {
            this.current = negotiate([options.locale], this.names) || options.locale;
        } else {
            const saved = this.key ? storage()?.getItem(this.key) : null;
            const wanted = (saved ? [saved] : []).concat(browserLocales());
            this.current = negotiate(wanted, this.names) || this.names[0] || "";
        }
    }

    get locale(): string {
        return this.current;
    }

    get locales(): Array<string> {
        return this.names.slice();
    }

    t: Translate<K> = (key, vars) => {
        const text = this.resolve(key);
        if (text === null) {
            if (!this.missed.includes(key)) {
                this.missed.push(key);
            }
            this.onMissing?.(key, this.current);

            return key;
        }

        return this.fill(text, vars);
    };

    has(key: string): boolean {
        return this.resolve(key) !== null;
    }

    setLocale(code: string): void {
        const next = negotiate([code], this.names) || String(code || "");
        if (!next || next === this.current) {
            return;
        }

        this.current = next;

        if (this.key) {
            try {
                storage()?.setItem(this.key, next);
            } catch (_) {} // a full or refused storage is not worth a throw
        }

        for (const listener of this.listeners.slice()) {
            listener(next);
        }
    }

    onChange(cb: (locale: string) => void): () => void {
        this.listeners.push(cb);

        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) {
                this.listeners.splice(i, 1);
            }
        };
    }

    missing(): Array<string> {
        return this.missed.slice();
    }

    /**
     * The text of the key, or null when there is none to answer with.
     */
    private resolve(key: string): string | null {
        const text = this.catalogues[this.current]?.[key];
        if (typeof text === "string" && text !== "") {
            return text;
        }

        if (this.fallback === "source") {
            const source = this.catalogues[this.names[0]]?.[key];
            if (typeof source === "string" && source !== "") {
                return source;
            }
        }

        return null;
    }

    private fill(text: string, vars?: I18nVars): string {
        if (!vars) {
            return text;
        }

        return text.replace(this.placeholder, (match, name) => {
            const value = vars[name];

            return typeof value === "undefined" || value === null ? match : String(value);
        });
    }
}

/**
 * The interface strings plugin.
 *
 * ```ts
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { i18n } from "@voidbase-cloud/sdk/i18n";
 * import type { MessageKey } from "./i18n/keys";
 * import en from "./i18n/en.json";
 * import ar from "./i18n/ar.json";
 *
 * const pb = new PocketBase("https://example.com").use(
 *     i18n<MessageKey>({ catalogues: { en, ar }, persist: true }),
 * );
 *
 * pb.i18n.t("greeting");                 // "Hello"
 * pb.i18n.t("hello", { name: "Ada" });   // "Hello, Ada"
 * pb.i18n.setLocale("ar");               // and every request from now on says so
 * ```
 *
 * The type parameter is the `MessageKey` of the generated
 * `i18n/keys.d.ts`, which narrows `pb.i18n.t` to the keys in use; without
 * one any string is a key.
 *
 * `client.unuse("i18n")` removes `client.i18n` and the `Accept-Language`
 * hook.
 */
export function i18n<K extends string = string>(
    options: I18nOptions,
): Plugin<{ i18n: I18nController<K> }> {
    return {
        name: "i18n",
        install(client: Client) {
            const controller = new Controller<K>(options);
            (client as I18nClient<Client, K>).i18n = controller;

            // the interface's language travels with every request, so the
            // instance's translations plugin answers content in it
            const removeHook =
                options.header === false
                    ? null
                    : client.hooks.beforeSend.add((_url, sendOptions) => {
                          sendOptions.headers = Object.assign({}, sendOptions.headers, {
                              "Accept-Language": controller.locale,
                          });
                      });

            return () => {
                removeHook?.();
                delete (client as any).i18n;
            };
        },
    };
}
