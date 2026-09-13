import { describe, assert, expect, test, beforeAll, afterAll, afterEach } from "vitest";
import Client from "@/Client";
import { ClientResponseError } from "@/ClientResponseError";
import { HookList, Plugin } from "@/tools/plugin";
import { FetchMock } from "./mocks";

describe("plugins and hooks", function () {
    const fetchMock = new FetchMock();

    beforeAll(function () {
        fetchMock.init();
    });

    afterAll(function () {
        fetchMock.restore();
    });

    afterEach(function () {
        fetchMock.clearMocks();
    });

    describe("HookList", function () {
        test("Should add, list, remove and clear in order", function () {
            const list = new HookList<() => number>();
            const a = () => 1;
            const b = () => 2;
            const c = () => 3;

            const removeA = list.add(a);
            list.add(b);
            list.add(c);
            assert.deepEqual(list.list(), [a, b, c]);
            assert.equal(list.size, 3);

            removeA();
            assert.deepEqual(list.list(), [b, c]);

            list.remove(c);
            assert.deepEqual(list.list(), [b]);

            // removing what is not there is a no-op
            list.remove(c);
            removeA();
            assert.deepEqual(list.list(), [b]);

            list.clear();
            assert.equal(list.size, 0);
        });

        test("Should iterate a snapshot so a hook can remove itself", function () {
            const list = new HookList<() => void>();
            const seen: Array<string> = [];
            const remove = list.add(() => {
                seen.push("a");
                remove();
            });
            list.add(() => seen.push("b"));

            for (const fn of list) {
                fn();
            }

            assert.deepEqual(seen, ["a", "b"]);
            assert.equal(list.size, 1);
        });
    });

    describe("hooks.beforeSend", function () {
        test("Should run after the beforeSend property, in add order, and see each other's changes", async function () {
            const client = new Client("test_base_url");
            const order: Array<string> = [];

            client.beforeSend = function (url, options) {
                order.push("property");
                options.headers = Object.assign({}, options.headers, { "X-A": "1" });
                return { url, options };
            };

            client.hooks.beforeSend.add((_, options) => {
                order.push("first");
                assert.equal(options.headers?.["X-A"], "1");
                options.headers = Object.assign({}, options.headers, { "X-B": "2" });
            });

            client.hooks.beforeSend.add((url, options) => {
                order.push("second");
                assert.equal(options.headers?.["X-B"], "2");
                return { url: url + "/replaced", options };
            });

            fetchMock.on({
                method: "GET",
                url: "test_base_url/old/replaced",
                replyCode: 200,
                replyBody: "123",
                additionalMatcher: function (_, config) {
                    return (
                        (config?.headers as any)?.["X-A"] == "1" &&
                        (config?.headers as any)?.["X-B"] == "2"
                    );
                },
            });

            const response = await client.send("/old", { method: "GET" });
            assert.equal(response, "123");
            assert.deepEqual(order, ["property", "first", "second"]);
        });

        test("Should not run a removed hook", async function () {
            const client = new Client("test_base_url");
            let calls = 0;

            const remove = client.hooks.beforeSend.add(() => {
                calls++;
            });

            fetchMock.on({ method: "GET", url: "test_base_url/x", replyCode: 200 });

            await client.send("/x", { method: "GET" });
            remove();
            await client.send("/x", { method: "GET" });

            assert.equal(calls, 1);
        });

        test("Should await an async hook", async function () {
            const client = new Client("test_base_url");

            client.hooks.beforeSend.add(async (url, options) => {
                await new Promise((r) => setTimeout(r, 5));
                return { url: url + "/async", options };
            });

            fetchMock.on({ method: "GET", url: "test_base_url/x/async", replyCode: 200, replyBody: "ok" });

            assert.equal(await client.send("/x", { method: "GET" }), "ok");
        });
    });

    describe("hooks.afterSend", function () {
        test("Should run after the afterSend property and chain the data in add order", async function () {
            const client = new Client("test_base_url");

            client.afterSend = function (_, data) {
                return data + "-property";
            };
            client.hooks.afterSend.add((_, data) => data + "-first");
            client.hooks.afterSend.add(async (_, data) => data + "-second");

            fetchMock.on({ method: "GET", url: "test_base_url/x", replyCode: 200, replyBody: "data" });

            assert.equal(await client.send("/x", { method: "GET" }), "data-property-first-second");
        });

        test("Should see the response and the options", async function () {
            const client = new Client("test_base_url");
            let seenStatus = 0;
            let seenMethod = "";

            client.hooks.afterSend.add((response, data, options) => {
                seenStatus = response.status;
                seenMethod = options.method || "";
                return data;
            });

            fetchMock.on({ method: "POST", url: "test_base_url/x", replyCode: 200, replyBody: { a: 1 } });

            assert.deepEqual(await client.send("/x", { method: "POST" }), { a: 1 });
            assert.equal(seenStatus, 200);
            assert.equal(seenMethod, "POST");
        });
    });

    describe("hooks.onError", function () {
        test("Should be called with the ClientResponseError of a failed reply and rethrow when no hook recovers", async function () {
            const client = new Client("test_base_url");
            const seen: Array<ClientResponseError> = [];

            client.hooks.onError.add((err) => {
                seen.push(err);
            });
            client.hooks.onError.add((err) => {
                seen.push(err);
            });

            fetchMock.on({
                method: "GET",
                url: "test_base_url/missing",
                replyCode: 404,
                replyBody: { message: "Not found." },
            });

            const err = await client.send("/missing", { method: "GET" }).catch((e) => e);

            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 404);
            assert.equal(err.message, "Not found.");
            assert.lengthOf(seen, 2);
            assert.equal(seen[0], seen[1]);
            assert.equal(seen[0].status, 404);
        });

        test("Should be called with a status 0 error when fetch throws and can recover with data", async function () {
            const client = new Client("test_base_url");
            const networkError = new TypeError("fetch failed");
            let seen: ClientResponseError | undefined;
            let seenUrl = "";

            client.hooks.onError.add((err, request) => {
                seen = err;
                seenUrl = request.url;
                return { recovered: true };
            });

            const result = await client.send("/x", {
                method: "GET",
                fetch: () => Promise.reject(networkError),
            });

            assert.deepEqual(result, { recovered: true });
            assert.instanceOf(seen, ClientResponseError);
            assert.equal(seen?.status, 0);
            assert.equal(seen?.isAbort, false);
            assert.equal(seen?.originalError, networkError);
            assert.equal(seenUrl, "test_base_url/x");
        });

        test("Should stop at the first hook that recovers", async function () {
            const client = new Client("test_base_url");
            const order: Array<string> = [];

            client.hooks.onError.add(() => {
                order.push("pass");
            });
            client.hooks.onError.add(() => {
                order.push("recover");
                return "recovered";
            });
            client.hooks.onError.add(() => {
                order.push("never");
                return "other";
            });

            fetchMock.on({ method: "GET", url: "test_base_url/x", replyCode: 500 });

            assert.equal(await client.send("/x", { method: "GET" }), "recovered");
            assert.deepEqual(order, ["pass", "recover"]);
        });

        test("Should parse a Response-like recovery through afterSend and the status check", async function () {
            const client = new Client("test_base_url");
            const afterSeen: Array<number> = [];

            client.hooks.afterSend.add((response, data) => {
                afterSeen.push(response.status);
                return data;
            });

            client.hooks.onError.add(() => ({
                status: 200,
                url: "test_base_url/cache",
                json: async () => ({ from: "cache" }),
            }));

            const result = await client.send("/x", {
                method: "GET",
                fetch: () => Promise.reject(new TypeError("fetch failed")),
            });

            assert.deepEqual(result, { from: "cache" });
            assert.deepEqual(afterSeen, [200]);

            // a recovery reply with an error status is thrown as a ClientResponseError
            client.hooks.onError.clear();
            client.hooks.onError.add(() => ({
                status: 403,
                url: "test_base_url/cache",
                json: async () => ({ message: "Forbidden." }),
            }));

            const err = await client
                .send("/x", { method: "GET", fetch: () => Promise.reject(new TypeError("x")) })
                .catch((e) => e);
            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 403);
            assert.equal(err.message, "Forbidden.");
        });

        test("Should let a removed hook go", async function () {
            const client = new Client("test_base_url");

            const remove = client.hooks.onError.add(() => "recovered");
            remove();

            fetchMock.on({ method: "GET", url: "test_base_url/x", replyCode: 500 });

            await expect(client.send("/x", { method: "GET" })).rejects.toThrow();
        });
    });

    describe("use() / unuse() / plugins", function () {
        test("Should install a plugin once, list it and uninstall it", function () {
            const client = new Client("test_base_url");
            const calls: Array<string> = [];

            const plugin: Plugin = {
                name: "example",
                install(c) {
                    calls.push("install");
                    assert.equal(c, client);
                    return () => calls.push("uninstall");
                },
            };

            assert.deepEqual(client.plugins, []);

            const same = client.use(plugin);
            assert.equal(same, client);
            assert.deepEqual(client.plugins, ["example"]);
            assert.deepEqual(calls, ["install"]);

            assert.throws(() => client.use(plugin), 'Plugin "example" is already installed.');
            assert.deepEqual(calls, ["install"]);

            client.unuse("example");
            assert.deepEqual(client.plugins, []);
            assert.deepEqual(calls, ["install", "uninstall"]);

            // unknown names and plugins without an uninstall are no-ops
            client.unuse("example");
            client.use({ name: "bare", install() {} });
            client.unuse("bare");
            assert.deepEqual(client.plugins, []);
        });

        test("Should list plugins in installation order and take hooks away on unuse", async function () {
            const client = new Client("test_base_url");

            const tagging: Plugin = {
                name: "tagging",
                install(c) {
                    const removeBefore = c.hooks.beforeSend.add((_, options) => {
                        options.headers = Object.assign({}, options.headers, { "X-Tag": "1" });
                    });
                    const removeAfter = c.hooks.afterSend.add((_, data) => data + "-tagged");
                    return () => {
                        removeBefore();
                        removeAfter();
                    };
                },
            };

            client.use({ name: "first", install() {} }).use(tagging);
            assert.deepEqual(client.plugins, ["first", "tagging"]);
            assert.equal(client.hooks.beforeSend.size, 1);
            assert.equal(client.hooks.afterSend.size, 1);

            fetchMock.on({
                method: "GET",
                url: "test_base_url/x",
                replyCode: 200,
                replyBody: "data",
                additionalMatcher: (_, config) => (config?.headers as any)?.["X-Tag"] == "1",
            });
            fetchMock.on({
                method: "GET",
                url: "test_base_url/x",
                replyCode: 200,
                replyBody: "plain",
                additionalMatcher: (_, config) => !(config?.headers as any)?.["X-Tag"],
            });

            assert.equal(await client.send("/x", { method: "GET" }), "data-tagged");

            client.unuse("tagging");
            assert.deepEqual(client.plugins, ["first"]);
            assert.equal(client.hooks.beforeSend.size, 0);
            assert.equal(client.hooks.afterSend.size, 0);
            assert.equal(await client.send("/x", { method: "GET" }), "plain");
        });
    });
});
