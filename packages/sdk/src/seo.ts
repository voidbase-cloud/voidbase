// The SEO helper, as a plugin: @voidbase-cloud/sdk/seo
//
// Installed, it attaches `client.seo`: `meta(target)` asks the instance's
// /api/seo/meta route for the tags of a path or a record through
// client.send, `apply(meta)` writes them into document.head (removing what
// it wrote last time, so applying on every navigation leaves one set),
// and `shareImage(collection, id)` is the URL of the record's share image
// under /api/seo/og. `seoHead(meta)` is the same set of tags as an HTML
// fragment, for a server-rendered page: the route's `html` when it sent
// one, else built from the fields. The plugin imports only types from the
// core package, so this entry carries no second copy of the client.

import type Client from "@voidbase-cloud/sdk";
import type { Plugin } from "@voidbase-cloud/sdk";

/**
 * What /api/seo/meta answers: the tags of one page.
 */
export interface SeoMeta {
    canonical?: string;
    title?: string;
    description?: string;
    image?: string;

    /**
     * The OpenGraph type ("website", "article", ...).
     */
    type?: string;
    locale?: string;

    /**
     * The JSON-LD object (or objects) of the page.
     */
    jsonld?: { [key: string]: any } | Array<{ [key: string]: any }> | null;

    /**
     * The URL of the page in each locale, written as
     * `<link rel="alternate" hreflang>` tags.
     */
    alternates?: Array<{ locale: string; url: string }>;

    /**
     * OpenGraph properties beyond the ones the fields above give, keyed
     * with or without their "og:" prefix; an array is one tag per value.
     */
    og?: { [key: string]: string | Array<string> };

    /**
     * Twitter card properties, keyed with or without their "twitter:"
     * prefix.
     */
    twitter?: { [key: string]: string };

    /**
     * The tags as the route rendered them, for a server-rendered page.
     */
    html?: string;
}

/**
 * The page `meta()` asks about: a path of the site, or a record.
 */
export type SeoTarget = { path: string } | { collection: string; id: string };

export type SeoImageFormat = "svg" | "png";

export interface SeoMetaOptions {
    /**
     * Aborts the request (the signal `client.send` accepts); with one the
     * request is its own, outside the auto-cancellation. Typed through
     * RequestInit so that the declaration does not pick the AbortSignal of
     * @types/node, which the declaration bundler cannot reference.
     */
    signal?: RequestInit["signal"];
}

/**
 * The controller attached as `client.seo`.
 */
export interface SeoController {
    /**
     * The tags of a path or a record, from GET /api/seo/meta. A newer call
     * cancels an older one still in flight (the client's auto-cancellation)
     * unless it brings its own signal.
     */
    meta(target: SeoTarget, options?: SeoMetaOptions): Promise<SeoMeta>;

    /**
     * Writes the tags into the document's head: the title, the canonical
     * link, the description, the alternates, the og: and twitter: metas
     * and the JSON-LD script. Elements it wrote before are removed first, and an element
     * the page already had for the same tag is updated rather than
     * doubled; everything it wrote is marked `data-vb-seo`.
     */
    apply(meta: SeoMeta, doc?: Document): void;

    /**
     * The URL of the record's share image, /api/seo/og/<collection>/<id>.<format>.
     */
    shareImage(collection: string, id: string, format?: SeoImageFormat): string;
}

/**
 * A client with the seo plugin installed (what `client.use(seo())` answers).
 */
export type SeoClient<T extends Client = Client> = T & {
    seo: SeoController;
};

const MARK = "data-vb-seo";

interface SeoTag {
    tag: "link" | "meta" | "script";

    /**
     * The selector of the element this tag is written to.
     */
    selector: string;
    attrs: { [key: string]: string };
    text?: string;
}

type Values = { [key: string]: Array<string> };

/**
 * The given properties over the defaults, prefixed, as lists of values
 * without the empty ones.
 */
function merged(
    prefix: string,
    defaults: { [key: string]: string | undefined },
    given: { [key: string]: string | Array<string> } | undefined,
): Values {
    const out: Values = {};
    const put = (key: string, value: string | Array<string> | undefined | null) => {
        const values = (Array.isArray(value) ? value : [value])
            .filter((v) => typeof v !== "undefined" && v !== null && v !== "")
            .map(String);
        const name = key.startsWith(prefix) ? key : prefix + key;
        if (values.length) {
            out[name] = values;
        } else {
            delete out[name];
        }
    };
    for (const key in defaults) {
        put(key, defaults[key]);
    }
    for (const key in given || {}) {
        put(key, given![key]);
    }
    return out;
}

function quoted(value: string): string {
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * The tags one meta answers, in the order they are written.
 */
function tags(meta: SeoMeta): Array<SeoTag> {
    const out: Array<SeoTag> = [];

    if (meta.canonical) {
        out.push({
            tag: "link",
            selector: 'link[rel="canonical"]',
            attrs: { rel: "canonical", href: meta.canonical },
        });
    }

    if (meta.description) {
        out.push({
            tag: "meta",
            selector: 'meta[name="description"]',
            attrs: { name: "description", content: meta.description },
        });
    }

    for (const alternate of meta.alternates || []) {
        if (!alternate || !alternate.locale || !alternate.url) {
            continue;
        }
        out.push({
            tag: "link",
            selector: `link[rel="alternate"][hreflang=${quoted(alternate.locale)}]`,
            attrs: { rel: "alternate", hreflang: alternate.locale, href: alternate.url },
        });
    }

    const og = merged(
        "og:",
        {
            "og:title": meta.title,
            "og:description": meta.description,
            "og:url": meta.canonical,
            "og:type": meta.type,
            "og:image": meta.image,
            "og:locale": meta.locale,
        },
        meta.og,
    );
    for (const property in og) {
        const many = og[property].length > 1;
        for (const content of og[property]) {
            out.push({
                tag: "meta",
                selector:
                    `meta[property=${quoted(property)}]` +
                    (many ? `[content=${quoted(content)}]` : ""),
                attrs: { property, content },
            });
        }
    }

    const twitter = merged(
        "twitter:",
        {
            "twitter:card":
                meta.image || meta.title || meta.description
                    ? meta.image
                        ? "summary_large_image"
                        : "summary"
                    : undefined,
            "twitter:title": meta.title,
            "twitter:description": meta.description,
            "twitter:image": meta.image,
        },
        meta.twitter,
    );
    for (const name in twitter) {
        const many = twitter[name].length > 1;
        for (const content of twitter[name]) {
            out.push({
                tag: "meta",
                selector:
                    `meta[name=${quoted(name)}]` +
                    (many ? `[content=${quoted(content)}]` : ""),
                attrs: { name, content },
            });
        }
    }

    if (meta.jsonld && (!Array.isArray(meta.jsonld) || meta.jsonld.length)) {
        out.push({
            tag: "script",
            selector: 'script[type="application/ld+json"]',
            attrs: { type: "application/ld+json" },
            text: JSON.stringify(meta.jsonld),
        });
    }

    return out;
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Keeps JSON from closing its script (a `<` is written as its escape,
 * which JSON.parse reads back as the same character).
 */
function escapeScript(json: string): string {
    return json
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

/**
 * The tags of a meta as an HTML fragment for a server-rendered page: the
 * `html` the route sent, else the title, the canonical link, the
 * description, the alternates, the og: and twitter: metas and the JSON-LD script built
 * from the fields (attribute values escaped, the JSON kept from closing
 * its script).
 */
export function seoHead(meta: SeoMeta): string {
    if (typeof meta.html === "string") {
        return meta.html;
    }

    const lines: Array<string> = [];
    if (meta.title) {
        lines.push(`<title>${escapeAttr(meta.title)}</title>`);
    }
    for (const tag of tags(meta)) {
        const attrs = Object.keys(tag.attrs)
            .map((name) => ` ${name}="${escapeAttr(tag.attrs[name])}"`)
            .join("");
        lines.push(
            tag.tag === "script"
                ? `<script${attrs}>${escapeScript(tag.text || "")}</script>`
                : `<${tag.tag}${attrs}>`,
        );
    }

    return lines.join("\n");
}

function applyTo(meta: SeoMeta, doc: Document): void {
    const head = doc.head || doc.getElementsByTagName("head")[0];
    if (!head) {
        return;
    }

    // what an earlier apply wrote
    head.querySelectorAll(`[${MARK}]`).forEach((el) => el.remove());

    if (meta.title) {
        doc.title = meta.title;
    }

    for (const tag of tags(meta)) {
        let el = head.querySelector(tag.selector);
        const fresh = !el;
        if (!el) {
            el = doc.createElement(tag.tag);
        }
        for (const name in tag.attrs) {
            el.setAttribute(name, tag.attrs[name]);
        }
        if (typeof tag.text !== "undefined") {
            el.textContent = tag.text;
        }
        el.setAttribute(MARK, "");
        if (fresh) {
            head.appendChild(el);
        }
    }
}

class Controller implements SeoController {
    constructor(private client: Client) {}

    meta(target: SeoTarget, options: SeoMetaOptions = {}): Promise<SeoMeta> {
        const query =
            "path" in target
                ? { path: target.path }
                : { collection: target.collection, id: target.id };

        const send: { [key: string]: any } = { method: "GET", query };
        if (options.signal) {
            send.signal = options.signal;
            send.requestKey = null;
        }

        return this.client.send<SeoMeta>("/api/seo/meta", send);
    }

    apply(meta: SeoMeta, doc?: Document): void {
        const target = doc || (typeof document !== "undefined" ? document : null);
        if (!target) {
            return; // no document here (the server)
        }
        applyTo(meta, target);
    }

    shareImage(collection: string, id: string, format: SeoImageFormat = "svg"): string {
        return this.client.buildURL(
            `/api/seo/og/${encodeURIComponent(collection)}/${encodeURIComponent(id)}.${format}`,
        );
    }
}

/**
 * The SEO plugin.
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { seo } from "@voidbase-cloud/sdk/seo";
 *
 * const pb = new PocketBase("https://example.com").use(seo());
 *
 * const meta = await pb.seo.meta({ collection: "posts", id: "RECORD_ID" });
 * pb.seo.apply(meta); // the title, canonical, og:, twitter: and JSON-LD tags
 * pb.seo.shareImage("posts", "RECORD_ID"); // https://example.com/api/seo/og/posts/RECORD_ID.svg
 * ```
 *
 * `client.unuse("seo")` removes `client.seo`; the tags applied stay.
 */
export function seo(): Plugin<{ seo: SeoController }> {
    return {
        name: "seo",
        install(client: Client) {
            (client as SeoClient).seo = new Controller(client);

            return () => {
                delete (client as any).seo;
            };
        },
    };
}
