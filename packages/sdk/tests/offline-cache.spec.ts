import { describe, assert, expect, test, beforeEach, afterEach } from "vitest";
import Client from "@/Client";
import { ClientResponseError } from "@/ClientResponseError";
import {
    offline,
    listCacheKey,
    OfflineStore,
    CacheChange,
    CachedRecord,
    CachedListResult,
} from "@/offline";

interface Call {
    url: string;
    method: string;
    body: any;
}

/**
 * The same fetch the queue's tests use: it either fails like a lost
 * network (a thrown TypeError) or answers the next scripted reply.
 */
class NetworkMock {
    down = false;
    calls: Array<Call> = [];
    replies: Array<{ status: number; body?: any }> = [];
    private originalFetch?: typeof fetch;

    init() {
        this.originalFetch = global.fetch;
        global.fetch = async (url: any, config: any) => {
            const body = typeof config?.body === "string" ? JSON.parse(config.body) : config?.body;
            this.calls.push({ url: String(url), method: config?.method || "GET", body });

            if (this.down) {
                throw new TypeError("fetch failed");
            }

            const reply = this.replies.shift() || { status: 200 };
            const replyBody =
                typeof reply.body !== "undefined"
                    ? reply.body
                    : reply.status < 400
                      ? Object.assign({ collectionName: "posts" }, body)
                      : { message: "refused" };

            return {
                url: String(url),
                status: reply.status,
                json: async () => replyBody,
            } as Response;
        };
    }

    restore() {
        global.fetch = this.originalFetch!;
    }
}

class MemoryStore implements OfflineStore {
    value: string | null = null;
    get() {
        return this.value;
    }
    set(value: string) {
        this.value = value;
    }
}

function record(n: number, extra: { [key: string]: any } = {}) {
    return Object.assign({ id: "post" + n, title: "post " + n, collectionName: "posts" }, extra);
}

function listReply(items: Array<any>, page = 1, perPage = 30) {
    return {
        status: 200,
        body: {
            page: page,
            perPage: perPage,
            totalItems: items.length,
            totalPages: 1,
            items: items,
        },
    };
}

// lets the background revalidation of a stale-while-revalidate read land
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("offline() cache", function () {
    const net = new NetworkMock();

    beforeEach(function () {
        net.init();
        net.down = false;
        net.calls = [];
        net.replies = [];
    });

    afterEach(function () {
        net.restore();
        global.window = undefined as any;
    });

    function newClient(options: Parameters<typeof offline>[0] = {}) {
        const cache = options.cache
            ? Object.assign({ store: new MemoryStore() }, options.cache)
            : undefined;

        return new Client("http://test").use(
            offline(Object.assign({ store: new MemoryStore() }, options, { cache })),
        );
    }

    test("Should cache nothing without the option", async function () {
        const pb = newClient();

        assert.isFalse(pb.offline.cache.enabled);
        assert.equal(pb.offline.cache.size(), 0);

        net.replies.push({ status: 200, body: record(1) });
        await pb.collection("posts").getOne("post1");

        assert.equal(pb.offline.cache.size(), 0);
    });

    test("Should touch only the named collections", async function () {
        const pb = newClient({ cache: { collections: ["posts"] } });

        net.replies.push({ status: 200, body: record(1) });
        net.replies.push({ status: 200, body: { id: "c1", collectionName: "comments" } });
        await pb.collection("posts").getOne("post1");
        await pb.collection("comments").getOne("c1");

        assert.equal(pb.offline.cache.size("posts"), 1);
        assert.equal(pb.offline.cache.size("comments"), 0);
        assert.equal(pb.offline.cache.size(), 1);

        // and an uncached collection still fails offline
        net.down = true;
        const err = await pb.collection("comments").getOne("c1").catch((e) => e);
        assert.instanceOf(err, ClientResponseError);
        assert.equal(err.status, 0);
    });

    describe("getOne()", function () {
        test("Should write a reply through and answer from the store when the network fails", async function () {
            const pb = newClient({ cache: { collections: ["posts"], mode: "offline-only" } });

            net.replies.push({ status: 200, body: record(1) });
            const fresh = await pb.collection("posts").getOne<CachedRecord>("post1");
            assert.equal(fresh.title, "post 1");
            assert.isUndefined(fresh.__fromCache);
            assert.deepEqual(pb.offline.cache.get("posts", "post1"), record(1));

            net.down = true;
            net.calls = [];
            const cached = await pb.collection("posts").getOne<CachedRecord>("post1");

            // the network was asked first, the store answered after it failed
            assert.lengthOf(net.calls, 1);
            assert.equal(cached.title, "post 1");
            assert.isTrue(cached.__fromCache);
        });

        test("Should throw the original error when the store has nothing", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });
            net.down = true;

            const err = await pb.collection("posts").getOne("post1").catch((e) => e);

            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 0);
            assert.equal(pb.offline.cache.size(), 0);
        });

        test("Should answer from the store first and revalidate in the background", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });
            const changes: Array<CacheChange> = [];
            pb.offline.on("cache", (c) => changes.push(c));

            net.replies.push({ status: 200, body: record(1) });
            await pb.collection("posts").getOne("post1");
            net.calls = [];

            net.replies.push({ status: 200, body: record(1, { title: "edited" }) });
            const stale = await pb.collection("posts").getOne<CachedRecord>("post1");

            // the store answered with what it had, not with the reply in flight
            assert.equal(stale.title, "post 1");
            assert.isTrue(stale.__fromCache);
            assert.deepEqual(changes, []);

            await settle();

            assert.lengthOf(net.calls, 1);
            assert.deepEqual(changes, [{ collection: "posts", kind: "one", key: "post1" }]);
            assert.equal(pb.offline.cache.get("posts", "post1")!.title, "edited");
        });

        test("Should not report a revalidation that landed the same", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });
            const changes: Array<CacheChange> = [];
            pb.offline.on("cache", (c) => changes.push(c));

            net.replies.push({ status: 200, body: record(1) });
            await pb.collection("posts").getOne("post1");

            net.replies.push({ status: 200, body: record(1) });
            await pb.collection("posts").getOne("post1");
            await settle();

            assert.deepEqual(changes, []);
        });

        test("Should not read the store while the network works in offline-only mode", async function () {
            const pb = newClient({ cache: { collections: ["posts"], mode: "offline-only" } });

            net.replies.push({ status: 200, body: record(1) });
            await pb.collection("posts").getOne("post1");

            net.replies.push({ status: 200, body: record(1, { title: "edited" }) });
            const second = await pb.collection("posts").getOne<CachedRecord>("post1");

            assert.equal(second.title, "edited");
            assert.isUndefined(second.__fromCache);
            assert.lengthOf(net.calls, 2);
        });
    });

    describe("getList()", function () {
        test("Should key a page by its query", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });

            net.replies.push(listReply([record(1), record(2)]));
            await pb.collection("posts").getList(1, 30);

            net.replies.push(listReply([record(3)]));
            await pb.collection("posts").getList(1, 30, { filter: 'title="post 3"' });

            net.down = true;

            const all = (await pb.collection("posts").getList(1, 30)) as CachedListResult;
            assert.isTrue(all.fromCache);
            assert.equal(all.totalItems, 2);
            assert.deepEqual(
                all.items.map((i) => i.id),
                ["post1", "post2"],
            );
            assert.isTrue(all.items[0].__fromCache);

            const filtered = (await pb
                .collection("posts")
                .getList(1, 30, { filter: 'title="post 3"' })) as CachedListResult;
            assert.deepEqual(
                filtered.items.map((i) => i.id),
                ["post3"],
            );

            // a page that was never read is not answered from the store
            await expect(pb.collection("posts").getList(2, 30)).rejects.toThrow();
        });

        test("Should make the same key for the same call", function () {
            assert.equal(listCacheKey(1, 30, { filter: "a=1" }), listCacheKey(1, 30, { query: { filter: "a=1" } }));
            assert.notEqual(listCacheKey(1, 30, { filter: "a=1" }), listCacheKey(1, 30, { filter: "a=2" }));
            assert.notEqual(listCacheKey(1, 30), listCacheKey(2, 30));
            // the request machinery is not part of the key
            assert.equal(listCacheKey(1, 30), listCacheKey(1, 30, { requestKey: "x", headers: { a: "b" } }));
        });

        test("Should report a background reply that landed differently", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });
            const changes: Array<CacheChange> = [];
            pb.offline.on("cache", (c) => changes.push(c));

            net.replies.push(listReply([record(1)]));
            await pb.collection("posts").getList(1, 30);

            net.replies.push(listReply([record(1), record(2)]));
            const stale = (await pb.collection("posts").getList(1, 30)) as CachedListResult;
            assert.isTrue(stale.fromCache);
            assert.lengthOf(stale.items, 1);

            await settle();

            assert.lengthOf(changes, 1);
            assert.equal(changes[0].kind, "list");
            assert.equal(changes[0].collection, "posts");
            assert.equal(changes[0].key, listCacheKey(1, 30));
            assert.equal(pb.offline.cache.size("posts"), 2);
        });
    });

    describe("realtime", function () {
        /**
         * Puts a subscription in place without an EventSource: the plugin
         * wraps the service's subscribe, which goes through realtime.subscribe.
         */
        function subscribed(pb: any) {
            let handler: ((data: any) => void) | undefined;
            pb.realtime.subscribe = async (_topic: string, callback: (data: any) => void) => {
                handler = callback;
                return async () => {};
            };

            return () => handler!;
        }

        test("Should follow create, update and delete of a cached collection", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });
            const handler = subscribed(pb);

            net.replies.push(listReply([record(1), record(2)]));
            await pb.collection("posts").getList(1, 30);

            const seen: Array<any> = [];
            const unsubscribe = await pb.collection("posts").subscribe("*", (e) => seen.push(e));
            assert.isFunction(unsubscribe);

            handler()({ action: "update", record: record(1, { title: "edited" }) });
            assert.equal(pb.offline.cache.get("posts", "post1")!.title, "edited");

            handler()({ action: "create", record: record(3) });
            assert.equal(pb.offline.cache.size("posts"), 3);

            handler()({ action: "delete", record: record(2) });
            assert.isUndefined(pb.offline.cache.get("posts", "post2"));

            // the application's own subscriber saw all three
            assert.deepEqual(
                seen.map((e) => e.action),
                ["update", "create", "delete"],
            );

            net.down = true;
            const list = (await pb.collection("posts").getList(1, 30)) as CachedListResult;
            assert.deepEqual(
                list.items.map((i) => i.id),
                ["post3", "post1"],
            );
            assert.equal(list.totalItems, 2);
        });
    });

    describe("the queue", function () {
        test("Should show a queued create in the next cached list and replace it on replay", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });

            net.replies.push(listReply([record(1)]));
            await pb.collection("posts").getList(1, 30);

            net.down = true;
            const created = await pb.collection("posts").create({ title: "in a tunnel" });
            assert.lengthOf(pb.offline.pending(), 1);

            const list = (await pb.collection("posts").getList(1, 30)) as CachedListResult;
            assert.isTrue(list.fromCache);
            assert.deepEqual(
                list.items.map((i) => i.id),
                [created.id, "post1"],
            );
            assert.equal(list.totalItems, 2);
            assert.equal(pb.offline.cache.get("posts", created.id)!.title, "in a tunnel");

            // the replay's record replaces the optimistic one
            net.down = false;
            net.replies.push({
                status: 200,
                body: {
                    id: created.id,
                    title: "in a tunnel",
                    collectionName: "posts",
                    created: "2026-09-11 10:00:00.000Z",
                },
            });
            await pb.offline.flush();

            assert.lengthOf(pb.offline.pending(), 0);
            assert.equal(pb.offline.cache.size("posts"), 2);
            assert.equal(
                pb.offline.cache.get("posts", created.id)!.created,
                "2026-09-11 10:00:00.000Z",
            );
        });

        test("Should apply a queued update and delete to the store", async function () {
            const pb = newClient({ cache: { collections: ["posts"] } });

            net.replies.push(listReply([record(1), record(2)]));
            await pb.collection("posts").getList(1, 30);

            net.down = true;
            await pb.collection("posts").update("post1", { title: "edited" });
            await pb.collection("posts").delete("post2");

            assert.equal(pb.offline.cache.get("posts", "post1")!.title, "edited");
            assert.isUndefined(pb.offline.cache.get("posts", "post2"));

            const list = (await pb.collection("posts").getList(1, 30)) as CachedListResult;
            assert.deepEqual(
                list.items.map((i) => i.id),
                ["post1"],
            );
            assert.equal(list.totalItems, 1);
        });
    });

    describe("max", function () {
        test("Should keep the most recently written records only", async function () {
            const pb = newClient({ cache: { collections: ["posts"], max: 2 } });

            for (const n of [1, 2, 3]) {
                net.replies.push({ status: 200, body: record(n) });
                await pb.collection("posts").getOne("post" + n);
            }

            assert.equal(pb.offline.cache.size("posts"), 2);
            assert.isUndefined(pb.offline.cache.get("posts", "post1"));
            assert.isDefined(pb.offline.cache.get("posts", "post2"));
            assert.isDefined(pb.offline.cache.get("posts", "post3"));
        });

        test("Should default to 500", function () {
            const pb = newClient({ cache: { collections: ["posts"] } });
            assert.equal(pb.offline.cache.max, 500);
            assert.equal(pb.offline.cache.mode, "stale-while-revalidate");
        });
    });

    describe("the store", function () {
        test("Should persist through its own store and load it in a new client", async function () {
            const store = new MemoryStore();

            const pb = new Client("http://test").use(
                offline({ store: new MemoryStore(), cache: { collections: ["posts"], store } }),
            );
            net.replies.push({ status: 200, body: record(1) });
            await pb.collection("posts").getOne("post1");

            assert.equal(JSON.parse(store.value!).posts.records.post1.record.title, "post 1");

            const pb2 = new Client("http://test").use(
                offline({
                    store: new MemoryStore(),
                    isOnline: () => false,
                    cache: { collections: ["posts"], store },
                }),
            );
            await pb2.offline.ready;

            assert.equal(pb2.offline.cache.get("posts", "post1")!.title, "post 1");

            // and the store answers a read while the network is gone
            net.down = true;
            const cached = await pb2.collection("posts").getOne<CachedRecord>("post1");
            assert.isTrue(cached.__fromCache);
            assert.lengthOf(net.calls, 1); // nothing was asked of the network
        });

        test("Should keep the queue and the cache under their own keys by default", async function () {
            const storage: { [key: string]: string } = {};
            (global as any).localStorage = {
                getItem: (k: string) => storage[k] ?? null,
                setItem: (k: string, v: string) => {
                    storage[k] = v;
                },
            };

            try {
                const pb = new Client("http://test").use(
                    offline({ key: "test_queue", cache: { collections: ["posts"] } }),
                );

                net.replies.push({ status: 200, body: record(1) });
                await pb.collection("posts").getOne("post1");

                net.down = true;
                await pb.collection("posts").delete("post1");

                assert.lengthOf(JSON.parse(storage.test_queue), 1);
                assert.deepEqual(Object.keys(JSON.parse(storage.test_queue_cache)), ["posts"]);
            } finally {
                delete (global as any).localStorage;
            }
        });

        test("Should clear one collection or all of them", async function () {
            const store = new MemoryStore();
            const pb = new Client("http://test").use(
                offline({
                    store: new MemoryStore(),
                    cache: { collections: ["posts", "comments"], store },
                }),
            );

            net.replies.push(listReply([record(1), record(2)]));
            await pb.collection("posts").getList(1, 30);
            net.replies.push({ status: 200, body: { id: "c1", collectionName: "comments" } });
            await pb.collection("comments").getOne("c1");

            assert.equal(pb.offline.cache.size(), 3);

            await pb.offline.cache.clear("posts");
            assert.equal(pb.offline.cache.size("posts"), 0);
            assert.equal(pb.offline.cache.size(), 1);
            assert.deepEqual(Object.keys(JSON.parse(store.value!)), ["comments"]);

            await pb.offline.cache.clear();
            assert.equal(pb.offline.cache.size(), 0);
            assert.equal(store.value, "{}");

            // and the next read is asked of the network again
            net.down = true;
            await expect(pb.collection("posts").getList(1, 30)).rejects.toThrow();
        });
    });

    test("Should restore the read methods on unuse()", async function () {
        const pb = new Client("http://test");
        const posts = pb.collection("posts");
        const originalGetOne = posts.getOne;

        const withOffline = pb.use(
            offline({ store: new MemoryStore(), cache: { collections: ["posts"] } }),
        );
        assert.equal(pb.collection("posts"), posts); // wraps the service it handed out earlier
        assert.notEqual(posts.getOne, originalGetOne);

        withOffline.unuse("offline");
        assert.equal(posts.getOne, originalGetOne);
    });
});
