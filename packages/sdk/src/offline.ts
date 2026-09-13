// The offline queue, as a plugin: @voidbase-cloud/sdk/offline
//
// Installed, it wraps create, update and delete of every RecordService the
// client hands out. A mutation the network refuses (fetch throws) or that is
// attempted while navigator.onLine is false is queued in a store and answered
// optimistically; the queue is replayed in order on the window "online" event
// and on client.offline.flush(). The plugin imports only types from the core
// package so this entry point carries no second copy of the client.
//
// With the `cache` option it also reads through a local store: getOne and
// getList of a named collection are written through to the store and
// answered from it when the network is gone (and, in the default
// stale-while-revalidate mode, answered from it first and revalidated in
// the background). Realtime events and the queue's own optimistic answers
// keep that store fresh.

import type Client from "@voidbase-cloud/sdk";
import type {
    Plugin,
    RecordService,
    ClientResponseError,
    ListResult,
} from "@voidbase-cloud/sdk";

export type MutationOp = "create" | "update" | "delete";

/**
 * A queued record mutation, as stored and replayed.
 */
export interface Mutation {
    /**
     * The collection id or name the mutation was made against.
     */
    collection: string;
    op: MutationOp;
    /**
     * The record id: chosen up front for a create, the caller's for the rest.
     */
    id: string;
    /**
     * The request body of a create or update (never a FormData; file uploads
     * are not queued).
     */
    body?: { [key: string]: any };
    /**
     * When it was queued, in milliseconds since the epoch.
     */
    at: number;
}

/**
 * Where the queue is kept between sessions: one string value, read at
 * install and written after every change. Sync or async.
 *
 * The default is localStorage under the `key` option when it exists, and
 * memory otherwise. Any `{ get, set }` pair fits, for instance React Native's
 * AsyncStorage: `{ get: () => AsyncStorage.getItem(k), set: (v) => AsyncStorage.setItem(k, v) }`.
 */
export interface OfflineStore {
    get(): string | null | undefined | Promise<string | null | undefined>;
    set(value: string): void | Promise<void>;
}

export interface OfflineOptions {
    /**
     * The store to persist the queue in (default: localStorage under `key`,
     * or memory when there is no localStorage).
     */
    store?: OfflineStore;

    /**
     * The localStorage key of the default store (default: "voidbase_offline_queue").
     */
    key?: string;

    /**
     * Whether the network is believed to be up; a mutation attempted while
     * it answers false is queued without a request
     * (default: `navigator.onLine !== false`).
     */
    isOnline?: () => boolean;

    /**
     * Whether an error thrown by a mutation means the network refused it
     * (default: a `ClientResponseError` with status 0 that is not an abort,
     * which is what the client throws when fetch throws).
     */
    isNetworkError?: (err: any) => boolean;

    /**
     * The id chosen up front for a create whose body carries none
     * (default: 15 lowercase alphanumeric characters, PocketBase's own
     * format; change it for a collection whose id field has other rules).
     */
    newId?: (collection: string) => string;

    /**
     * Whether to replay the queue on the window "online" event (default: true).
     */
    listen?: boolean;

    /**
     * Reads through a local store, for the named collections. Without it
     * nothing is cached and a read that fails offline still fails.
     */
    cache?: OfflineCacheOptions;
}

export interface OfflineEvents {
    /**
     * A mutation was queued (and answered optimistically).
     */
    queued: (mutation: Mutation) => void;

    /**
     * A replay run ended having replayed at least one mutation.
     */
    flushed: (result: { replayed: number; remaining: number }) => void;

    /**
     * A replayed mutation was refused by the server with a 4xx and dropped.
     */
    failed: (failure: { mutation: Mutation; error: ClientResponseError }) => void;

    /**
     * A read that was answered from the store was revalidated in the
     * background and the reply landed differently: the application may
     * render again (stale-while-revalidate only).
     */
    cache: (change: CacheChange) => void;
}

/**
 * A client with the offline plugin installed (what `client.use(offline())` answers).
 */
export type OfflineClient<T extends Client = Client> = T & { offline: OfflineQueue };

interface Originals {
    create: RecordService["create"];
    update: RecordService["update"];
    delete: RecordService["delete"];

    // only of a cached collection
    getOne?: RecordService["getOne"];
    getList?: RecordService["getList"];
    subscribe?: RecordService["subscribe"];
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A 15-character id in PocketBase's default format.
 */
export function newRecordId(): string {
    const bytes = new Uint8Array(15);
    const c = typeof crypto !== "undefined" ? crypto : undefined;
    if (c && typeof c.getRandomValues === "function") {
        c.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    let id = "";
    for (let i = 0; i < bytes.length; i++) {
        id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    }

    return id;
}

function defaultStore(key: string): OfflineStore {
    try {
        if (typeof localStorage !== "undefined" && localStorage) {
            // probe once so a storage that throws (private mode) falls back to memory
            localStorage.getItem(key);
            return {
                get: () => localStorage.getItem(key),
                set: (value) => localStorage.setItem(key, value),
            };
        }
    } catch (_) {}

    let memory: string | null = null;
    return {
        get: () => memory,
        set: (value) => {
            memory = value;
        },
    };
}

function defaultIsOnline(): boolean {
    return !(typeof navigator !== "undefined" && navigator && navigator.onLine === false);
}

function defaultIsNetworkError(err: any): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        err.status === 0 &&
        !err.isAbort &&
        // a ClientResponseError, or at least not a bare validation error
        (err.name || "").startsWith("ClientResponseError")
    );
}

function noop(): void {}

function isQueueableBody(body: any): body is { [key: string]: any } {
    return (
        typeof body === "object" &&
        body !== null &&
        !(typeof FormData !== "undefined" && body instanceof FormData) &&
        !(typeof Blob !== "undefined" && body instanceof Blob)
    );
}

// -------------------------------------------------------------------
// the read cache
// -------------------------------------------------------------------

/**
 * How a cached read is answered.
 *
 * - `"stale-while-revalidate"` (the default): what the store holds is
 *   answered at once and the request is made in the background; when it
 *   lands differently, the `"cache"` event reports it.
 * - `"offline-only"`: the store is read only after a request failed for a
 *   network reason.
 */
export type OfflineCacheMode = "stale-while-revalidate" | "offline-only";

export interface OfflineCacheOptions {
    /**
     * The collections whose `getOne` and `getList` are cached. Nothing
     * else is touched.
     */
    collections: Array<string>;

    /**
     * The store to keep the cached records in (default: localStorage, or
     * memory when there is no localStorage, as the queue's own default
     * store, but under its own key, so that the two never collide).
     */
    store?: OfflineStore;

    /**
     * The localStorage key of the default store (default:
     * "voidbase_offline_cache", or the queue's `key` with "_cache"
     * appended when one was given).
     */
    key?: string;

    /**
     * Which answer comes first (default: "stale-while-revalidate").
     */
    mode?: OfflineCacheMode;

    /**
     * How many records are kept per collection, the least recently
     * written dropped first (default: 500). This is a cache for
     * rendering, not a local database.
     */
    max?: number;
}

/**
 * What the "cache" event reports: a background revalidation that landed
 * differently from what the store was asked for.
 */
export interface CacheChange {
    collection: string;
    kind: "one" | "list";

    /**
     * The record id for `"one"`, the list's query key for `"list"`.
     */
    key: string;
}

/**
 * A record as a cached read answers it: `__fromCache` is `true` when it
 * came from the store rather than from the network.
 *
 * ```ts
 * const post = await pb.collection("posts").getOne<CachedRecord<Post>>(id);
 * if (post.__fromCache) { ... }
 * ```
 */
export type CachedRecord<T = { [key: string]: any }> = T & { __fromCache?: true };

/**
 * A list as a cached read answers it: `fromCache` is `true` when it came
 * from the store, and so is `__fromCache` on each of its items.
 */
export type CachedListResult<T = { [key: string]: any }> = ListResult<CachedRecord<T>> & {
    fromCache?: true;
};

/**
 * One cached record and when it was last written.
 */
interface CachedEntry {
    record: { [key: string]: any };
    at: number;
}

/**
 * One cached page: the ids of its items (the records themselves are kept
 * once, in `records`) and the counts the list was answered with.
 */
interface CachedList {
    ids: Array<string>;
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
    at: number;
}

interface CollectionCache {
    records: { [id: string]: CachedEntry };
    lists: { [key: string]: CachedList };
}

// the option keys the client itself reads; every other key a read carries
// is a query parameter, and so part of the key its page is cached under
const SEND_OPTION_KEYS = [
    "requestKey",
    "$cancelKey",
    "$autoCancel",
    "fetch",
    "headers",
    "body",
    "query",
    "params",
    "cache",
    "credentials",
    "integrity",
    "keepalive",
    "method",
    "mode",
    "redirect",
    "referrer",
    "referrerPolicy",
    "signal",
    "window",
];

/**
 * The key a page is cached under: the page, its size and every query
 * parameter of the call (the filter, the sort, the fields, the expand),
 * so that the same call reads back what it wrote and a different one does
 * not.
 */
export function listCacheKey(
    page: number,
    perPage: number,
    options?: { [key: string]: any },
): string {
    const params: { [key: string]: any } = {};

    for (const key in options || {}) {
        if (SEND_OPTION_KEYS.includes(key) || typeof options![key] === "function") {
            continue;
        }
        params[key] = options![key];
    }
    Object.assign(params, options?.params, options?.query);

    delete params.page;
    delete params.perPage;

    const parts = Object.keys(params)
        .sort()
        .map((key) => {
            const value = params[key];
            return (
                key +
                "=" +
                (value !== null && typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value))
            );
        });

    return [String(page), String(perPage)].concat(parts).join("|");
}

function fromCache(record: { [key: string]: any }): any {
    return Object.assign({}, record, { __fromCache: true });
}

function fromCacheList(result: { items: Array<any>; [key: string]: any }): any {
    return Object.assign({}, result, {
        fromCache: true,
        items: (result.items || []).map(fromCache),
    });
}

/**
 * The records a cached read may answer from, attached as
 * `client.offline.cache` by the plugin.
 *
 * ```js
 * pb.offline.cache.get("posts", id); // the cached copy, or undefined
 * pb.offline.cache.size();           // how many records are kept
 * await pb.offline.cache.clear("posts");
 * ```
 */
export class OfflineRecordCache {
    /**
     * Resolves once the store has been read.
     */
    readonly ready: Promise<void>;

    /**
     * Which answer comes first.
     */
    readonly mode: OfflineCacheMode;

    /**
     * How many records are kept per collection.
     */
    readonly max: number;

    private names: Set<string>;
    private store?: OfflineStore;
    private data: { [collection: string]: CollectionCache } = {};

    constructor(options?: OfflineCacheOptions, queueKey?: string) {
        this.names = new Set((options?.collections || []).filter((name) => !!name));
        this.mode =
            options?.mode === "offline-only" ? "offline-only" : "stale-while-revalidate";
        this.max =
            typeof options?.max === "number" && options.max > 0
                ? Math.floor(options.max)
                : 500;

        if (this.names.size) {
            this.store =
                options?.store ||
                defaultStore(
                    options?.key ||
                        (queueKey ? queueKey + "_cache" : "voidbase_offline_cache"),
                );
        }

        this.ready = this.load();
    }

    /**
     * Whether any collection is cached at all.
     */
    get enabled(): boolean {
        return this.names.size > 0;
    }

    /**
     * Whether the reads of the collection are cached.
     */
    has(collection: string): boolean {
        return this.names.has(collection);
    }

    /**
     * The cached copy of a record, or undefined. It reads what has been
     * loaded: await `client.offline.ready` first.
     */
    get<T = { [key: string]: any }>(collection: string, id: string): T | undefined {
        const entry = this.data[collection]?.records[id];

        return entry ? (Object.assign({}, entry.record) as T) : undefined;
    }

    /**
     * How many records are cached, of one collection or of all of them.
     */
    size(collection?: string): number {
        if (typeof collection === "string") {
            return Object.keys(this.data[collection]?.records || {}).length;
        }

        let total = 0;
        for (const name in this.data) {
            total += Object.keys(this.data[name].records).length;
        }

        return total;
    }

    /**
     * Drops what is cached, of one collection or of all of them.
     */
    async clear(collection?: string): Promise<void> {
        if (typeof collection === "string") {
            delete this.data[collection];
        } else {
            this.data = {};
        }

        await this.persist();
    }

    /**
     * Writes the cache to its store.
     */
    async persist(): Promise<void> {
        if (!this.store) {
            return;
        }

        try {
            await this.store.set(JSON.stringify(this.data));
        } catch (_) {
            // a store that cannot be written keeps the cache in memory only
        }
    }

    // --- what the queue reads and writes ---

    /**
     * The stored page with its items resolved, or undefined. An item that
     * has been dropped meanwhile is left out.
     */
    readList(collection: string, key: string): { [key: string]: any } | undefined {
        const cache = this.data[collection];
        const list = cache?.lists[key];
        if (!list) {
            return undefined;
        }

        const items: Array<any> = [];
        for (const id of list.ids) {
            const entry = cache.records[id];
            if (entry) {
                items.push(Object.assign({}, entry.record));
            }
        }

        return {
            page: list.page,
            perPage: list.perPage,
            totalItems: list.totalItems,
            totalPages: list.totalPages,
            items: items,
        };
    }

    /**
     * Writes one record. `prepend` puts a record that is new to the cache
     * at the front of every cached page of the collection, which is what
     * a create (queued, sent or seen through realtime) does.
     */
    putRecord(
        collection: string,
        record: { [key: string]: any } | undefined | null,
        options?: { prepend?: boolean },
    ): void {
        if (!this.has(collection) || !record || typeof record.id !== "string" || !record.id) {
            return;
        }

        const cache = this.collection(collection);
        const isNew = !cache.records[record.id];
        this.write(cache, record);

        if (options?.prepend && isNew) {
            for (const key in cache.lists) {
                const list = cache.lists[key];
                if (list.ids.includes(record.id)) {
                    continue;
                }
                list.ids.unshift(record.id);
                list.totalItems++;
                list.at = Date.now();
            }
        }

        this.trim(cache);
    }

    /**
     * Merges a body over a record already cached; a record that was never
     * read is not invented.
     */
    mergeRecord(collection: string, id: string, body: { [key: string]: any }): void {
        const entry = this.has(collection) ? this.data[collection]?.records[id] : undefined;
        if (!entry) {
            return;
        }

        const cache = this.collection(collection);
        this.write(cache, Object.assign({}, entry.record, body, { id: id }));
        this.trim(cache);
    }

    /**
     * Drops one record and takes it out of every cached page.
     */
    removeRecord(collection: string, id: string): void {
        const cache = this.data[collection];
        if (!this.has(collection) || !cache) {
            return;
        }

        delete cache.records[id];

        for (const key in cache.lists) {
            const list = cache.lists[key];
            const i = list.ids.indexOf(id);
            if (i < 0) {
                continue;
            }
            list.ids.splice(i, 1);
            list.totalItems = Math.max(0, list.totalItems - 1);
            list.at = Date.now();
        }
    }

    /**
     * Writes one page and every record in it.
     */
    putList(collection: string, key: string, result: any): void {
        if (!this.has(collection) || !result || !Array.isArray(result.items)) {
            return;
        }

        const cache = this.collection(collection);
        const ids: Array<string> = [];

        for (const item of result.items) {
            if (!item || typeof item.id !== "string" || !item.id) {
                continue;
            }
            ids.push(item.id);
            this.write(cache, item);
        }

        cache.lists[key] = {
            ids: ids,
            page: typeof result.page === "number" ? result.page : 1,
            perPage: typeof result.perPage === "number" ? result.perPage : ids.length,
            totalItems: typeof result.totalItems === "number" ? result.totalItems : ids.length,
            totalPages: typeof result.totalPages === "number" ? result.totalPages : 1,
            at: Date.now(),
        };

        this.trim(cache);
    }

    // --- the store ---

    private collection(name: string): CollectionCache {
        if (!this.data[name]) {
            this.data[name] = { records: {}, lists: {} };
        }

        return this.data[name];
    }

    private write(cache: CollectionCache, record: { [key: string]: any }): void {
        const copy = Object.assign({}, record);
        delete copy.__fromCache;

        cache.records[record.id] = { record: copy, at: Date.now() };
    }

    /**
     * Drops the least recently written records (and pages) of a
     * collection down to `max`.
     */
    private trim(cache: CollectionCache): void {
        const ids = Object.keys(cache.records);
        if (ids.length > this.max) {
            ids.sort((a, b) => cache.records[a].at - cache.records[b].at);
            for (const id of ids.slice(0, ids.length - this.max)) {
                delete cache.records[id];
            }
        }

        const keys = Object.keys(cache.lists);
        if (keys.length > this.max) {
            keys.sort((a, b) => cache.lists[a].at - cache.lists[b].at);
            for (const key of keys.slice(0, keys.length - this.max)) {
                delete cache.lists[key];
            }
        }
    }

    private async load(): Promise<void> {
        if (!this.store) {
            return;
        }

        let parsed: any;
        try {
            const raw = await this.store.get();
            parsed = raw ? JSON.parse(raw) : undefined;
        } catch (_) {
            return; // an unreadable store starts empty
        }

        if (!parsed || typeof parsed !== "object") {
            return;
        }

        for (const name in parsed) {
            // a collection that is no longer cached is dropped
            if (!this.has(name) || !parsed[name] || typeof parsed[name] !== "object") {
                continue;
            }

            const cache = this.collection(name);
            const records = parsed[name].records;
            const lists = parsed[name].lists;

            for (const id in records || {}) {
                // what was written while the store was being read is newer
                if (!cache.records[id] && records[id]?.record) {
                    cache.records[id] = {
                        record: records[id].record,
                        at: typeof records[id].at === "number" ? records[id].at : 0,
                    };
                }
            }

            for (const key in lists || {}) {
                if (!cache.lists[key] && Array.isArray(lists[key]?.ids)) {
                    cache.lists[key] = lists[key];
                }
            }
        }
    }
}

/**
 * The queue, attached as `client.offline` by the plugin.
 */
export class OfflineQueue {
    /**
     * Resolves once the persisted queue and cache have been loaded from
     * their stores.
     */
    readonly ready: Promise<void>;

    /**
     * The records cached reads answer from (empty without the `cache`
     * option).
     */
    readonly cache: OfflineRecordCache;

    private queue: Array<Mutation> = [];
    private flushing?: Promise<void>;
    private listeners = new Map<keyof OfflineEvents, Set<(payload: any) => void>>();
    private originals = new Map<RecordService<any>, Originals>();
    private store: OfflineStore;
    private isOnline: () => boolean;
    private isNetworkError: (err: any) => boolean;
    private newId: (collection: string) => string;

    constructor(
        private client: Client,
        options: OfflineOptions = {},
    ) {
        this.store = options.store || defaultStore(options.key || "voidbase_offline_queue");
        this.isOnline = options.isOnline || defaultIsOnline;
        this.isNetworkError = options.isNetworkError || defaultIsNetworkError;
        this.newId = options.newId || (() => newRecordId());
        this.cache = new OfflineRecordCache(options.cache, options.key);

        this.ready = Promise.all([this.load(), this.cache.ready]).then(() => undefined);
    }

    /**
     * The queued mutations, oldest first (a copy).
     */
    pending(): Array<Mutation> {
        return this.queue.slice();
    }

    /**
     * Subscribes to an event; returns the unsubscribe function.
     */
    on<E extends keyof OfflineEvents>(event: E, fn: OfflineEvents[E]): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(fn);

        return () => {
            set.delete(fn);
        };
    }

    /**
     * Replays the queue in order through the client, oldest first.
     *
     * A network failure stops the run and keeps that mutation and the rest
     * for the next one; a 4xx reply drops the mutation and reports it through
     * the "failed" event; any other failure (a 5xx) stops the run as well.
     * A run already in progress is joined rather than started twice.
     */
    flush(): Promise<void> {
        if (!this.flushing) {
            this.flushing = this.replay().finally(() => {
                this.flushing = undefined;
            });
        }

        return this.flushing;
    }

    /**
     * Drops every queued mutation without replaying it.
     */
    async clear(): Promise<void> {
        this.queue = [];
        await this.persist();
    }

    // --- the plugin's side ---

    /**
     * Wraps the mutation methods of a service, once.
     */
    wrap(service: RecordService<any>): void {
        if (this.originals.has(service)) {
            return;
        }

        const o: Originals = {
            create: service.create,
            update: service.update,
            delete: service.delete,
        };
        this.originals.set(service, o);

        service.create = (body?: any, options?: any) => this.create(service, o, body, options);
        service.update = (id: string, body?: any, options?: any) =>
            this.update(service, o, id, body, options);
        service.delete = (id: string, options?: any) => this.delete(service, o, id, options);

        if (!this.cache.has(service.collectionIdOrName)) {
            return;
        }

        o.getOne = service.getOne;
        o.getList = service.getList;
        o.subscribe = service.subscribe;

        service.getOne = ((id: string, options?: any) =>
            this.getOne(service, o, id, options)) as RecordService["getOne"];

        service.getList = ((page = 1, perPage = 30, options?: any) =>
            this.getList(service, o, page, perPage, options)) as RecordService["getList"];

        // the cached records follow the collection's realtime events, under
        // whatever the application subscribed with
        service.subscribe = ((topic: string, callback: (data: any) => void, options?: any) =>
            o.subscribe!.call(
                service,
                topic,
                (event: any) => {
                    this.cacheRealtime(service.collectionIdOrName, event);
                    callback(event);
                },
                options,
            )) as RecordService["subscribe"];
    }

    /**
     * Restores the methods of every wrapped service.
     */
    unwrapAll(): void {
        for (const service of this.originals.keys()) {
            delete (service as any).create;
            delete (service as any).update;
            delete (service as any).delete;
            delete (service as any).getOne;
            delete (service as any).getList;
            delete (service as any).subscribe;
        }
        this.originals.clear();
    }

    // --- the wrapped methods ---

    private async create(
        service: RecordService<any>,
        o: Originals,
        body?: any,
        options?: any,
    ): Promise<any> {
        if (!isQueueableBody(body)) {
            // a FormData (file upload) cannot be stored; send it as it is
            return o.create.call(service, body, options);
        }

        const collection = service.collectionIdOrName;

        // the id is chosen up front so that a replay creates the same record
        // the caller was answered with, and so that a create whose reply was
        // lost is not created twice
        const id =
            typeof body.id === "string" && body.id ? body.id : this.newId(collection);
        body = Object.assign({}, body, { id });

        const queued = () =>
            this.enqueue(
                { collection, op: "create", id, body, at: Date.now() },
                Object.assign({ collectionName: collection }, body),
            );

        if (!this.isOnline()) {
            return queued();
        }

        try {
            const record = await o.create.call(service, body, options);
            await this.cacheMutation(
                { collection, op: "create", id, body, at: Date.now() },
                record,
            );
            return record;
        } catch (err) {
            if (this.isNetworkError(err)) {
                return queued();
            }
            throw err;
        }
    }

    private async update(
        service: RecordService<any>,
        o: Originals,
        id: string,
        body?: any,
        options?: any,
    ): Promise<any> {
        if (!isQueueableBody(body)) {
            return o.update.call(service, id, body, options);
        }

        const collection = service.collectionIdOrName;
        const queued = () =>
            this.enqueue(
                { collection, op: "update", id, body, at: Date.now() },
                Object.assign({}, body, { id }),
            );

        if (!this.isOnline()) {
            return queued();
        }

        try {
            const record = await o.update.call(service, id, body, options);
            await this.cacheMutation(
                { collection, op: "update", id, body, at: Date.now() },
                record,
            );
            return record;
        } catch (err) {
            if (this.isNetworkError(err)) {
                return queued();
            }
            throw err;
        }
    }

    private async delete(
        service: RecordService<any>,
        o: Originals,
        id: string,
        options?: any,
    ): Promise<boolean> {
        const collection = service.collectionIdOrName;
        const queued = () =>
            this.enqueue({ collection, op: "delete", id, at: Date.now() }, true);

        if (!this.isOnline()) {
            return queued();
        }

        try {
            const deleted = await o.delete.call(service, id, options);
            await this.cacheMutation({ collection, op: "delete", id, at: Date.now() }, null);
            return deleted;
        } catch (err) {
            if (this.isNetworkError(err)) {
                return queued();
            }
            throw err;
        }
    }

    // --- the cached reads ---

    /**
     * getOne of a cached collection: the store answers first in
     * stale-while-revalidate mode and after a network failure in both,
     * and every reply from the network is written through.
     */
    private async getOne(
        service: RecordService<any>,
        o: Originals,
        id: string,
        options?: any,
    ): Promise<any> {
        const collection = service.collectionIdOrName;
        const network = (): Promise<any> => o.getOne!.call(service, id, options);

        await this.cache.ready;
        const cached = this.cache.get(collection, id);

        if (cached && (this.cache.mode === "stale-while-revalidate" || !this.isOnline())) {
            if (this.isOnline()) {
                const before = JSON.stringify(cached);
                network().then((record: any) => {
                    this.cache.putRecord(collection, record);
                    this.cache.persist();
                    if (JSON.stringify(this.cache.get(collection, id)) !== before) {
                        this.emit("cache", { collection, kind: "one", key: id });
                    }
                }, noop); // a revalidation that fails leaves what the store holds
            }

            return fromCache(cached);
        }

        try {
            const record = await network();
            this.cache.putRecord(collection, record);
            await this.cache.persist();

            return record;
        } catch (err) {
            if (cached && this.isNetworkError(err)) {
                return fromCache(cached);
            }
            throw err;
        }
    }

    /**
     * getList of a cached collection, page by page: each page is cached
     * under the key of its query, so that the same call reads back what it
     * wrote and a different filter or sort does not.
     */
    private async getList(
        service: RecordService<any>,
        o: Originals,
        page: number,
        perPage: number,
        options?: any,
    ): Promise<any> {
        const collection = service.collectionIdOrName;
        const key = listCacheKey(page, perPage, options);
        const network = (): Promise<any> => o.getList!.call(service, page, perPage, options);

        await this.cache.ready;
        const cached = this.cache.readList(collection, key);

        if (cached && (this.cache.mode === "stale-while-revalidate" || !this.isOnline())) {
            if (this.isOnline()) {
                const before = JSON.stringify(cached);
                network().then((result: any) => {
                    this.cache.putList(collection, key, result);
                    this.cache.persist();
                    if (JSON.stringify(this.cache.readList(collection, key)) !== before) {
                        this.emit("cache", { collection, kind: "list", key });
                    }
                }, noop);
            }

            return fromCacheList(cached as any);
        }

        try {
            const result = await network();
            this.cache.putList(collection, key, result);
            await this.cache.persist();

            return result;
        } catch (err) {
            if (cached && this.isNetworkError(err)) {
                return fromCacheList(cached as any);
            }
            throw err;
        }
    }

    /**
     * A mutation as the cache keeps it: the optimistic answer of a queued
     * one, the server's record of one the network took.
     */
    private async cacheMutation(mutation: Mutation, record: any): Promise<void> {
        if (!this.cache.has(mutation.collection)) {
            return;
        }

        const body = record && typeof record === "object" ? record : mutation.body;

        if (mutation.op === "delete") {
            this.cache.removeRecord(mutation.collection, mutation.id);
        } else if (mutation.op === "create") {
            this.cache.putRecord(mutation.collection, body, { prepend: true });
        } else {
            this.cache.mergeRecord(mutation.collection, mutation.id, body || {});
        }

        await this.cache.persist();
    }

    /**
     * A realtime event of a cached collection, applied to the store.
     */
    private cacheRealtime(collection: string, event: any): void {
        const record = event?.record;
        if (!this.cache.has(collection) || !record || typeof record.id !== "string") {
            return;
        }

        if (event.action === "delete") {
            this.cache.removeRecord(collection, record.id);
        } else if (event.action === "create") {
            this.cache.putRecord(collection, record, { prepend: true });
        } else if (event.action === "update") {
            this.cache.putRecord(collection, record);
        } else {
            return;
        }

        this.cache.persist().catch(noop);
    }

    // --- the queue ---

    private async enqueue<T>(mutation: Mutation, answer: T): Promise<T> {
        this.queue.push(mutation);
        await this.persist();
        // the optimistic answer is what the store holds until the replay
        await this.cacheMutation(mutation, answer);
        this.emit("queued", mutation);

        return answer;
    }

    private async replay(): Promise<void> {
        await this.ready;

        let replayed = 0;

        while (this.queue.length) {
            const m = this.queue[0];

            try {
                await this.send(m);
            } catch (err: any) {
                if (this.isNetworkError(err)) {
                    break; // still offline: keep this one and the rest
                }

                const status = typeof err?.status === "number" ? err.status : 0;
                if (status >= 400 && status < 500) {
                    // the server refused it: it will not succeed later either
                    this.queue.shift();
                    await this.persist();
                    this.emit("failed", { mutation: m, error: err });
                    continue;
                }

                break; // a server error or something unexpected: keep and stop
            }

            this.queue.shift();
            replayed++;
            await this.persist();
        }

        if (replayed) {
            this.emit("flushed", { replayed, remaining: this.queue.length });
        }
    }

    /**
     * Sends one mutation through the unwrapped service method, so that the
     * client's hooks run and the plugin's own wrapper does not.
     */
    private async send(m: Mutation): Promise<any> {
        const service = this.client.collection(m.collection);
        this.wrap(service);
        const o = this.originals.get(service)!;

        // requestKey null: the replay must not auto-cancel, or be cancelled
        // by, a mutation the application sends meanwhile
        const options = { requestKey: null };

        let result: any;
        switch (m.op) {
            case "create":
                result = await o.create.call(service, m.body, options);
                break;
            case "update":
                result = await o.update.call(service, m.id, m.body, options);
                break;
            case "delete":
                result = await o.delete.call(service, m.id, options);
                break;
        }

        // the record the server made replaces the optimistic one
        await this.cacheMutation(m, result);

        return result;
    }

    private async load(): Promise<void> {
        let persisted: Array<Mutation> = [];

        try {
            const raw = await this.store.get();
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    persisted = parsed.filter(
                        (m) => m && typeof m.collection === "string" && typeof m.op === "string",
                    );
                }
            }
        } catch (_) {
            // an unreadable store starts empty
        }

        if (persisted.length) {
            // what was persisted is older than what was queued meanwhile
            this.queue = persisted.concat(this.queue);
            await this.persist();
        }
    }

    private async persist(): Promise<void> {
        try {
            await this.store.set(JSON.stringify(this.queue));
        } catch (_) {
            // a store that cannot be written keeps the queue in memory only
        }
    }

    private emit<E extends keyof OfflineEvents>(
        event: E,
        payload: Parameters<OfflineEvents[E]>[0],
    ): void {
        const set = this.listeners.get(event);
        if (!set) {
            return;
        }

        for (const fn of Array.from(set)) {
            try {
                fn(payload);
            } catch (err) {
                console?.error?.(err);
            }
        }
    }
}

/**
 * The offline queue plugin.
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { offline } from "@voidbase-cloud/sdk/offline";
 *
 * const pb = new PocketBase("https://example.com").use(offline());
 *
 * await pb.collection("posts").create({ title: "written in a tunnel" }); // answers at once
 * pb.offline.pending();                                                 // [{ collection: "posts", op: "create", id, body, at }]
 * pb.offline.on("failed", ({ mutation, error }) => ...);               // a 4xx on replay
 * await pb.offline.flush();                                             // or wait for the "online" event
 * ```
 *
 * With the `cache` option it also reads through a local store:
 *
 * ```js
 * const pb = new PocketBase("https://example.com").use(
 *     offline({ cache: { collections: ["posts"] } }),
 * );
 *
 * const list = await pb.collection("posts").getList(1, 20); // the store answers, the network follows
 * list.fromCache;                                           // true when it did
 * pb.offline.on("cache", ({ collection, kind, key }) => ...); // the reply landed differently
 * pb.offline.cache.get("posts", id);
 * ```
 *
 * Install it before taking services from the client: it wraps the
 * services `client.collection()` hands out from then on.
 */
export function offline(options: OfflineOptions = {}): Plugin<{ offline: OfflineQueue }> {
    return {
        name: "offline",
        install(client: Client) {
            const queue = new OfflineQueue(client, options);
            (client as OfflineClient).offline = queue;

            // wrap every service the client hands out from now on
            const previous = Object.getOwnPropertyDescriptor(client, "collection");
            const original = client.collection.bind(client);
            client.collection = ((name: string) => {
                const service = original(name);
                queue.wrap(service);
                return service;
            }) as typeof client.collection;

            // replay when the network comes back
            const onOnline = () => {
                queue.flush().catch(() => {});
            };
            const listen =
                options.listen !== false &&
                typeof window !== "undefined" &&
                typeof window.addEventListener === "function";
            if (listen) {
                window.addEventListener("online", onOnline);
            }

            // and what was left from the last session, once loaded
            queue.ready.then(() => {
                if (queue.pending().length && (options.isOnline || defaultIsOnline)()) {
                    onOnline();
                }
            });

            return () => {
                if (listen) {
                    window.removeEventListener("online", onOnline);
                }
                queue.unwrapAll();
                if (previous) {
                    Object.defineProperty(client, "collection", previous);
                } else {
                    delete (client as any).collection;
                }
                delete (client as any).offline;
            };
        },
    };
}
