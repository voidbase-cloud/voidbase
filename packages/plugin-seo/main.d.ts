import type { Context } from "hono";
import type { AppEnv, Bindings, Collection } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
/** where the answers' facts come from; the defaults read the instance, a test hands in what it likes */
export interface SeoSource {
    /** the collections this instance has */
    collections(env: Bindings): Promise<Collection[]>;
    /** the instance's name from its settings, or "" when it has none */
    appName(env: Bindings): Promise<string>;
    /** the records of a public collection that match the filter (a PocketBase filter, "" for all), at most `limit` */
    records(env: Bindings, collection: Collection, filter: string, limit: number): Promise<Record<string, unknown>[]>;
    /** the one record of the collection matching the filter that the request's caller may list, expanded; null when none */
    record(c: Context<AppEnv>, collection: Collection, filter: string, expand: string): Promise<Record<string, unknown> | null>;
    /** the PNG of the card's SVG at 1200x630, or null when this platform's rasteriser could not load or parse it */
    rasterize(svg: string): Promise<Uint8Array | null>;
}
/** VOIDBASE_SITE_URL without a trailing slash, else the request's origin */
export declare const siteUrlOf: (c: Context<AppEnv>) => string;
/** one VOIDBASE_SITEMAP entry: `collection[filter]:/path/{field}` */
export interface SitemapEntry {
    collection: string;
    filter: string;
    pattern: string;
}
/** the entries VOIDBASE_SITEMAP declares; a malformed one is skipped with a warning */
export declare function parseSitemap(spec: string): SitemapEntry[];
export declare const SITEMAP_LIMIT = 50000;
/** a record's URL for the pattern: each {field} is the record's value, URL-encoded; null when a value is empty */
export declare function locOf(site: string, pattern: string, record: Record<string, unknown>): string | null;
export { SEO_API, SEO_FILES, SEO_PNG_VAR, seoPngOn, seoRedirectLines } from "@voidbase-cloud/voidbase/plugins/seo-paths";
export { buildMeta, CARD_FONT_FAMILY, etagOf, excerpt, matchPath, notModified, parseSeo, shareCard, splitLocale, wrap, type MetaAnswer, type SeoMapping } from "./lib/meta";
/** the plugin over a source of its own: tests hand in collections, a name and records without a database */
export declare const seoWith: (source?: Partial<SeoSource>) => Omit<Plugin, "manifest">;
/** the shipped plugin: the instance's own collections, settings and records */
declare const seo: Omit<Plugin, "manifest">;
export default seo;
