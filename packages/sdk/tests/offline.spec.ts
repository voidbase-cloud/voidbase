import { describe, assert, expect, test, beforeEach, afterEach } from "vitest";
import Client from "@/Client";
import { VoidBase } from "@/VoidBase";
import { ClientResponseError } from "@/ClientResponseError";
import { offline, OfflineStore, Mutation, newRecordId } from "@/offline";

interface Call {
    url: string;
    method: string;
    body: any;
}

/**
 * A fetch that can be switched between failing like a lost network (a thrown
 * TypeError, as fetch does) and answering; each answer is scripted per call.
 */
class NetworkMock {
    down = true;
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
    writes = 0;
    get() {
        return this.value;
    }
    set(value: string) {
        this.value = value;
        this.writes++;
    }
}

const ID_RE = /^[a-z0-9]{15}$/;

describe("offline()", function () {
    const net = new NetworkMock();

    beforeEach(function () {
        net.init();
        net.down = true;
        net.calls = [];
        net.replies = [];
    });

    afterEach(function () {
        net.restore();
        global.window = undefined as any;
    });

    function newClient(options: Parameters<typeof offline>[0] = {}) {
        return new Client("http://test").use(offline({ store: new MemoryStore(), ...options }));
    }

    test("newRecordId() makes 15-character ids", function () {
        const a = newRecordId();
        const b = newRecordId();
        assert.match(a, ID_RE);
        assert.match(b, ID_RE);
        assert.notEqual(a, b);
    });

    test("Should install as a plugin and attach client.offline", function () {
        const pb = newClient();

        assert.deepEqual(pb.plugins, ["offline"]);
        assert.isFunction(pb.offline.pending);
        assert.isFunction(pb.offline.flush);
        assert.deepEqual(pb.offline.pending(), []);
    });

    describe("queueing", function () {
        test("Should queue a create the network refused, with an id chosen up front, and answer it", async function () {
            const pb = newClient();
            const events: Array<Mutation> = [];
            pb.offline.on("queued", (m) => events.push(m));

            const record = await pb.collection("posts").create({ title: "in a tunnel" });

            assert.match(record.id, ID_RE);
            assert.equal(record.title, "in a tunnel");
            assert.equal(record.collectionName, "posts");

            // the request was attempted with that id in the body
            assert.lengthOf(net.calls, 1);
            assert.equal(net.calls[0].method, "POST");
            assert.equal(net.calls[0].url, "http://test/api/collections/posts/records");
            assert.equal(net.calls[0].body.id, record.id);

            const pending = pb.offline.pending();
            assert.lengthOf(pending, 1);
            assert.equal(pending[0].collection, "posts");
            assert.equal(pending[0].op, "create");
            assert.equal(pending[0].id, record.id);
            assert.deepEqual(pending[0].body, { title: "in a tunnel", id: record.id });
            assert.isNumber(pending[0].at);

            assert.lengthOf(events, 1);
            assert.equal(events[0], pending[0]);
        });

        test("Should keep a caller-chosen id", async function () {
            const pb = newClient();

            const record = await pb.collection("posts").create({ id: "abcdefghijklmno", title: "x" });

            assert.equal(record.id, "abcdefghijklmno");
            assert.equal(pb.offline.pending()[0].id, "abcdefghijklmno");
        });

        test("Should answer an update with the body merged over the id, and a delete with true", async function () {
            const pb = newClient();

            const updated = await pb.collection("posts").update("abcdefghijklmno", { title: "later" });
            assert.deepEqual(updated, { title: "later", id: "abcdefghijklmno" });

            const deleted = await pb.collection("posts").delete("abcdefghijklmno");
            assert.equal(deleted, true);

            const pending = pb.offline.pending();
            assert.lengthOf(pending, 2);
            assert.equal(pending[0].op, "update");
            assert.deepEqual(pending[0].body, { title: "later" });
            assert.equal(pending[1].op, "delete");
            assert.equal(pending[1].id, "abcdefghijklmno");
            assert.isUndefined(pending[1].body);
        });

        test("Should queue without a request when isOnline answers false", async function () {
            const pb = newClient({ isOnline: () => false });
            net.down = false;

            await pb.collection("posts").create({ title: "x" });
            await pb.collection("posts").update("abcdefghijklmno", { title: "y" });
            await pb.collection("posts").delete("abcdefghijklmno");

            assert.lengthOf(net.calls, 0);
            assert.lengthOf(pb.offline.pending(), 3);
        });

        test("Should read navigator.onLine by default", async function () {
            const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
            Object.defineProperty(globalThis, "navigator", {
                value: { onLine: false },
                configurable: true,
                writable: true,
            });

            try {
                const pb = newClient();
                net.down = false;

                await pb.collection("posts").create({ title: "x" });

                assert.lengthOf(net.calls, 0);
                assert.lengthOf(pb.offline.pending(), 1);
            } finally {
                if (original) {
                    Object.defineProperty(globalThis, "navigator", original);
                } else {
                    delete (globalThis as any).navigator;
                }
            }
        });

        test("Should not queue a reply the server refused", async function () {
            const pb = newClient();
            net.down = false;
            net.replies.push({ status: 400, body: { message: "Failed to create record." } });

            const err = await pb.collection("posts").create({ title: "x" }).catch((e) => e);

            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 400);
            assert.lengthOf(pb.offline.pending(), 0);
        });

        test("Should not queue a FormData body", async function () {
            const pb = newClient();
            const form = new FormData();
            form.append("title", "x");

            const err = await pb.collection("posts").create(form).catch((e) => e);

            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 0);
            assert.lengthOf(pb.offline.pending(), 0);
        });

        test("Should send every create with an id chosen up front while online", async function () {
            const pb = newClient();
            net.down = false;

            const record = await pb.collection("posts").create({ title: "x" });

            assert.lengthOf(net.calls, 1);
            assert.match(net.calls[0].body.id, ID_RE);
            assert.equal(record.id, net.calls[0].body.id);
            assert.lengthOf(pb.offline.pending(), 0);
        });

        test("Should use the newId option", async function () {
            const pb = newClient({ newId: (collection) => collection + "_1" });

            const record = await pb.collection("posts").create({ title: "x" });

            assert.equal(record.id, "posts_1");
        });
    });

    describe("flush()", function () {
        test("Should replay in order once the network answers, then report flushed", async function () {
            const pb = newClient();
            const flushed: Array<any> = [];
            pb.offline.on("flushed", (r) => flushed.push(r));

            const created = await pb.collection("posts").create({ title: "a" });
            await pb.collection("posts").update(created.id, { title: "b" });
            await pb.collection("comments").create({ post: created.id, text: "c" });
            await pb.collection("posts").delete(created.id);
            assert.lengthOf(pb.offline.pending(), 4);
            net.calls = [];

            net.down = false;
            await pb.offline.flush();

            assert.deepEqual(
                net.calls.map((c) => [c.method, c.url]),
                [
                    ["POST", "http://test/api/collections/posts/records"],
                    ["PATCH", "http://test/api/collections/posts/records/" + created.id],
                    ["POST", "http://test/api/collections/comments/records"],
                    ["DELETE", "http://test/api/collections/posts/records/" + created.id],
                ],
            );
            assert.deepEqual(net.calls[0].body, { title: "a", id: created.id });
            assert.deepEqual(net.calls[1].body, { title: "b" });
            assert.equal(net.calls[2].body.post, created.id);

            assert.lengthOf(pb.offline.pending(), 0);
            assert.deepEqual(flushed, [{ replayed: 4, remaining: 0 }]);
        });

        test("Should stop on a network failure and keep the rest", async function () {
            const pb = newClient();
            const failed: Array<any> = [];
            const flushed: Array<any> = [];
            pb.offline.on("failed", (f) => failed.push(f));
            pb.offline.on("flushed", (r) => flushed.push(r));

            await pb.collection("posts").create({ title: "a" });
            await pb.collection("posts").create({ title: "b" });
            net.calls = [];

            // still down: nothing replayed, nothing lost
            await pb.offline.flush();
            assert.lengthOf(net.calls, 1);
            assert.lengthOf(pb.offline.pending(), 2);
            assert.lengthOf(failed, 0);
            assert.lengthOf(flushed, 0);

            // up for one request, then down again
            net.down = false;
            net.calls = [];
            global.fetch = ((realFetch) => async (url: any, config: any) => {
                const r = await realFetch(url, config);
                net.down = true;
                return r;
            })(global.fetch);

            await pb.offline.flush();
            assert.lengthOf(net.calls, 2);
            assert.lengthOf(pb.offline.pending(), 1);
            assert.equal(pb.offline.pending()[0].body?.title, "b");
            assert.deepEqual(flushed, [{ replayed: 1, remaining: 1 }]);
        });

        test("Should drop a mutation the server refuses with a 4xx and report it", async function () {
            const pb = newClient();
            const failed: Array<{ mutation: Mutation; error: ClientResponseError }> = [];
            pb.offline.on("failed", (f) => failed.push(f));

            const first = await pb.collection("posts").create({ title: "refused" });
            const second = await pb.collection("posts").create({ title: "fine" });

            net.down = false;
            net.replies.push({ status: 400, body: { message: "Failed to create record." } });
            net.calls = [];
            await pb.offline.flush();

            assert.lengthOf(net.calls, 2);
            assert.lengthOf(pb.offline.pending(), 0);

            assert.lengthOf(failed, 1);
            assert.equal(failed[0].mutation.id, first.id);
            assert.equal(failed[0].mutation.op, "create");
            assert.instanceOf(failed[0].error, ClientResponseError);
            assert.equal(failed[0].error.status, 400);
            assert.equal(failed[0].error.message, "Failed to create record.");
            assert.notEqual(failed[0].mutation.id, second.id);
        });

        test("Should keep the queue on a 5xx", async function () {
            const pb = newClient();
            const failed: Array<any> = [];
            pb.offline.on("failed", (f) => failed.push(f));

            await pb.collection("posts").create({ title: "a" });

            net.down = false;
            net.replies.push({ status: 500 });
            await pb.offline.flush();

            assert.lengthOf(pb.offline.pending(), 1);
            assert.lengthOf(failed, 0);
        });

        test("Should replay through the client's hooks and without auto-cancellation", async function () {
            const pb = newClient();
            const seen: Array<string> = [];
            const keys: Array<any> = [];
            pb.hooks.beforeSend.add((url, options) => {
                seen.push(options.method + " " + url);
                keys.push(options.requestKey);
            });

            await pb.collection("posts").create({ title: "a" });
            await pb.collection("posts").create({ title: "b" });
            seen.length = 0;
            keys.length = 0;

            net.down = false;
            await pb.offline.flush();

            assert.lengthOf(seen, 2);
            // requestKey null is what the replay passes so it is never auto-cancelled
            assert.deepEqual(keys, [null, null]);
            assert.lengthOf(pb.offline.pending(), 0);
        });

        test("Should join a flush already running", async function () {
            const pb = newClient();
            await pb.collection("posts").create({ title: "a" });

            net.down = false;
            const a = pb.offline.flush();
            const b = pb.offline.flush();
            assert.equal(a, b);
            await a;
        });

        test("Should flush on the window online event", async function () {
            const listeners: { [event: string]: Array<() => void> } = {};
            global.window = {
                addEventListener: (event: string, fn: () => void) => {
                    (listeners[event] ||= []).push(fn);
                },
                removeEventListener: (event: string, fn: () => void) => {
                    listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
                },
            } as any;

            const pb = newClient();
            assert.lengthOf(listeners.online, 1);

            await pb.collection("posts").create({ title: "a" });
            net.down = false;
            net.calls = [];

            listeners.online[0]();
            await pb.offline.flush(); // joins the run the event started

            assert.lengthOf(net.calls, 1);
            assert.lengthOf(pb.offline.pending(), 0);

            pb.unuse("offline");
            assert.lengthOf(listeners.online, 0);
        });
    });

    describe("persistence", function () {
        test("Should persist through the injected store and load it in a new client", async function () {
            const store = new MemoryStore();
            const pb1 = new Client("http://test").use(offline({ store }));

            const created = await pb1.collection("posts").create({ title: "a" });
            await pb1.collection("posts").delete("abcdefghijklmno");

            assert.isAtLeast(store.writes, 2);
            const stored = JSON.parse(store.value!);
            assert.lengthOf(stored, 2);
            assert.equal(stored[0].id, created.id);
            assert.deepEqual(stored[0].body, { title: "a", id: created.id });
            assert.equal(stored[1].op, "delete");

            // a new client on the same store starts with that queue
            const pb2 = new Client("http://test").use(offline({ store, isOnline: () => false }));
            await pb2.offline.ready;
            assert.deepEqual(pb2.offline.pending(), stored);

            // and replays it
            net.down = false;
            net.calls = [];
            await pb2.offline.flush();
            assert.deepEqual(
                net.calls.map((c) => c.method),
                ["POST", "DELETE"],
            );
            assert.lengthOf(pb2.offline.pending(), 0);
            assert.equal(store.value, "[]");
        });

        test("Should put what was persisted before what was queued while loading", async function () {
            const store: OfflineStore = {
                get: () =>
                    new Promise((resolve) =>
                        setTimeout(
                            () =>
                                resolve(
                                    JSON.stringify([
                                        { collection: "posts", op: "delete", id: "older", at: 1 },
                                    ]),
                                ),
                            10,
                        ),
                    ),
                set: () => {},
            };
            const pb = new Client("http://test").use(offline({ store, isOnline: () => false }));

            await pb.collection("posts").delete("newer");
            await pb.offline.ready;

            assert.deepEqual(
                pb.offline.pending().map((m) => m.id),
                ["older", "newer"],
            );
        });

        test("Should replay a persisted queue at install when online", async function () {
            const store = new MemoryStore();
            store.value = JSON.stringify([
                { collection: "posts", op: "delete", id: "abcdefghijklmno", at: 1 },
            ]);
            net.down = false;

            const pb = new Client("http://test").use(offline({ store }));
            await pb.offline.ready;
            await pb.offline.flush();

            assert.lengthOf(net.calls, 1);
            assert.equal(net.calls[0].method, "DELETE");
            assert.lengthOf(pb.offline.pending(), 0);
        });

        test("Should start empty on an unreadable store", async function () {
            const store: OfflineStore = {
                get: () => "not json",
                set: () => {
                    throw new Error("read only");
                },
            };
            const pb = new Client("http://test").use(offline({ store }));
            await pb.offline.ready;

            await pb.collection("posts").delete("abcdefghijklmno");
            assert.lengthOf(pb.offline.pending(), 1);
        });

        test("Should use localStorage under the key by default", async function () {
            const storage: { [key: string]: string } = {};
            (global as any).localStorage = {
                getItem: (k: string) => storage[k] ?? null,
                setItem: (k: string, v: string) => {
                    storage[k] = v;
                },
            };

            try {
                const pb = new Client("http://test").use(offline({ key: "test_queue" }));
                await pb.collection("posts").delete("abcdefghijklmno");

                assert.lengthOf(JSON.parse(storage.test_queue), 1);
            } finally {
                delete (global as any).localStorage;
            }
        });
    });

    describe("unuse()", function () {
        test("Should restore the services and remove client.offline", async function () {
            const pb = new Client("http://test");
            const posts = pb.collection("posts");
            const originalCreate = posts.create;

            const withOffline = pb.use(offline({ store: new MemoryStore() }));
            assert.equal(pb.collection("posts"), posts);
            assert.notEqual(posts.create, originalCreate);

            withOffline.unuse("offline");
            assert.equal(posts.create, originalCreate);
            assert.isUndefined((pb as any).offline);
            assert.deepEqual(pb.plugins, []);

            // a refused request is thrown again, not queued
            await expect(pb.collection("posts").create({ title: "x" })).rejects.toThrow();
        });

        test("Should compose with VoidBase's typed collection()", async function () {
            const pb = new VoidBase("http://test").use(offline({ store: new MemoryStore() }));

            const record = await pb.collection("posts").create({ title: "x" });
            assert.match(record.id, ID_RE);
            assert.lengthOf(pb.offline.pending(), 1);

            pb.unuse("offline");
            assert.equal(pb.collection("posts").collectionIdOrName, "posts");
        });
    });
});
