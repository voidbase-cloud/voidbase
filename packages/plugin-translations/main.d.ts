import type { Bindings, Collection } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
/** one stored translation: the record's collection and id, the field, the locale and the text */
export interface TranslationRow {
    collection: string;
    record: string;
    field: string;
    locale: string;
    value: string;
}
/** where the facts come from; the defaults read the instance, a test hands in what it likes */
export interface TranslationsSource {
    /** the collections this instance has */
    collections(env: Bindings): Promise<Collection[]>;
    /** the translations of these records in these locales, whatever their collection: one call per response */
    translations(env: Bindings, ids: string[], locales: string[]): Promise<TranslationRow[]>;
    /** a page of a collection's record ids in stored order, and how many records it has */
    recordIds(env: Bindings, collection: Collection, page: number, perPage: number): Promise<{
        ids: string[];
        totalItems: number;
    }>;
    /** how many records a collection has, and per locale how many (record, field) pairs of these fields have a translation */
    counts(env: Bindings, collection: Collection, fields: string[]): Promise<{
        records: number;
        translated: Record<string, number>;
    }>;
}
export declare const TRANSLATIONS = "translations";
/** the default source: the instance's own tables, the translations looked up in chunks under D1's parameter limit */
export declare const dbSource: TranslationsSource;
/** the collection the plugin owns, in the shape POST /api/collections takes; rules: anyone reads, superusers write */
export declare const TRANSLATIONS_COLLECTION: Record<string, unknown>;
/**
 * VOIDBASE_TRANSLATABLE: entries separated by `;`, each `collection:field,field`. Whitespace around a name is
 * ignored, a collection named twice has the union of its fields, and an entry with no `:`, an invalid name or no
 * field is skipped with a warning.
 */
export declare function parseTranslatable(spec: string): Map<string, string[]>;
/** VOIDBASE_LOCALES: comma-separated language tags, lowercased and deduplicated; the first is the source locale */
export declare function parseLocales(spec: string): string[];
export interface TranslationsConfig {
    locales: string[];
    source: string;
    translatable: Map<string, string[]>;
}
export declare const configOf: (env?: object) => TranslationsConfig;
/** what /api/plugins says: the locales, the source, and the declared collections with their fields */
export declare const translationsInfo: (env?: object) => {
    source: string;
    locales: string[];
    collections: Record<string, string[]>;
};
/**
 * The locale to serve: `?locale=` when it is one of the locales (an unknown one is the source, not an error),
 * else the best Accept-Language match by q value (a tag matches its locale exactly, or by primary subtag: en-US
 * finds en, `*` is the source), else the source.
 */
export declare function negotiateLocale(query: string | undefined, acceptLanguage: string | undefined, locales: string[]): string;
type Json = Record<string, unknown>;
/**
 * Swap the translatable fields of these rows into `locale`, falling back down the locales' order; the source locale
 * means the record's own value when it is not empty. `translated` names the locale each swapped field came from.
 */
export declare function applyTranslations(rows: Json[], collection: string, cfg: TranslationsConfig, locale: string, found: TranslationRow[]): void;
/** the plugin over a source of its own: tests hand in collections, records and translations without a database */
export declare function translationsWith(source?: Partial<TranslationsSource>): Omit<Plugin, "manifest">;
/** the shipped plugin: the instance's own collections, records and translations */
declare const translations: Omit<Plugin, "manifest">;
export default translations;
export {};
