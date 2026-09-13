import type { Collection } from "@voidbase-cloud/voidbase/types";
import { type LocaleSetup } from "@voidbase-cloud/voidbase/plugins/seo-locales";
import type { SitemapEntry } from "../main";
/** one VOIDBASE_SEO entry: the schema.org type of a collection's pages and which fields feed which key */
export interface SeoMapping {
    collection: string;
    type: string;
    fields: Record<string, string>;
}
/** split on the commas outside brackets, braces and quotes */
export declare function splitOutside(spec: string): string[];
/** the mappings VOIDBASE_SEO declares; a malformed entry or mapping is skipped with a warning */
export declare function parseSeo(spec: string): SeoMapping[];
/** the relations the mappings reach through, for the records service's `expand` */
export declare const expandOf: (mapping: SeoMapping | null) => string;
export interface PathMatch {
    entry: SitemapEntry;
    values: Record<string, string>;
}
/** the first sitemap entry whose pattern matches the path, each {field} captured and URL-decoded */
export declare function matchPath(entries: SitemapEntry[], path: string): PathMatch | null;
/** a filter string literal: the lexer takes a backslash before a quote or a backslash */
export declare const quoteFilter: (v: string) => string;
/** the entry's own filter and the captured values, as one filter the records service judges with the list rule */
export declare const lookupFilter: (entry: SitemapEntry, values: Record<string, string>) => string;
export { alternatesOf, localesOf, localizedUrl, splitLocale, type LocaleSetup } from "@voidbase-cloud/voidbase/plugins/seo-locales";
export interface MetaAnswer {
    canonical: string;
    title: string;
    description: string;
    image: string;
    type: string;
    locale: string;
    alternates: {
        locale: string;
        url: string;
    }[];
    jsonld: Record<string, unknown>;
    og: Record<string, string | string[]>;
    twitter: Record<string, string>;
    html: string;
}
export interface MetaInput {
    site: string;
    appName: string;
    collection: Collection;
    record: Record<string, unknown>;
    canonical: string;
    mapping: SeoMapping | null;
    imageSize: string;
    locale: string;
    locales: LocaleSetup | null;
    /** the share card's URL, og:image when no image field is mapped or the record has no file in it */
    card: string;
}
export declare const stripTags: (s: string) => string;
export declare const DESCRIPTION_MAX = 200;
/** the first 200 characters, cut back to a word boundary and closed with an ellipsis when it was longer */
export declare function excerpt(s: string, max?: number): string;
export declare const escapeHtml: (s: string) => string;
/** the record's value at a field path; one relation hop reads the expanded record */
export declare function valueAt(record: Record<string, unknown>, path: string): unknown;
/** the title and description of a record's page, mapped or defaulted; what the meta answer and the card share */
export declare function pageText(collection: Collection, record: Record<string, unknown>, mapping: SeoMapping | null): {
    title: string;
    description: string;
};
/** the URL of the record's mapped image: a file field through the files route (a thumb when sized), a URL as is */
export declare function imageUrl(input: Pick<MetaInput, "site" | "collection" | "record" | "mapping" | "imageSize">): string;
/** the whole answer: the tags as data, the JSON-LD, and the html fragment a page puts in its head */
export declare function buildMeta(input: MetaInput): MetaAnswer;
export declare const CARD: {
    readonly width: 1200;
    readonly height: 630;
    readonly titleChars: 30;
    readonly titleLines: 3;
    readonly descriptionChars: 70;
};
export declare const DEFAULT_THEME = "#1f2430";
export declare const CARD_FONT_FAMILY = "Inter";
/** VOIDBASE_SEO_THEME when it is a hex colour or a colour name, else the default dark */
export declare const themeOf: (v: string) => string;
/** words wrapped to at most `chars` per line and `lines` lines, the last one ellipsised when text was left over */
export declare function wrap(text: string, chars: number, lines: number): string[];
/** the 1200x630 SVG card: the app's name, the title on up to three lines, the description on one */
export declare function shareCard(opts: {
    appName: string;
    title: string;
    description: string;
    theme: string;
}): string;
/** the ETag of anything derived from one record on one version of voidbase: `"<version>-<updated ms>"` */
export declare const etagOf: (version: string, record: Record<string, unknown>) => string;
/** whether If-None-Match names this ETag (weak or strong) or everything */
export declare function notModified(ifNoneMatch: string | undefined, etag: string): boolean;
