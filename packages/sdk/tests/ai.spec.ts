// @vitest-environment jsdom

import { describe, assert, test, beforeEach, afterEach, vi } from "vitest";
import Client from "@/Client";
import { ClientResponseError } from "@/ClientResponseError";
import {
    ai,
    mountChat,
    AiMessage,
    AiReply,
    AiConversationRecord,
    AiMessageRecord,
} from "@/ai";
import { dummyJWT } from "./mocks";

interface Call {
    url: string;
    method: string;
    headers: { [key: string]: string };
    body: any;
    signal: any;
}

/**
 * A fetch that records every call and answers each with the scripted
 * reply (a 200 echoing an assistant message by default).
 */
class NetworkMock {
    calls: Array<Call> = [];
    replies: Array<{ status: number; body?: any; sse?: string }> = [];
    private originalFetch?: typeof fetch;

    init() {
        this.originalFetch = global.fetch;
        global.fetch = async (url: any, config: any) => {
            const body =
                typeof config?.body === "string" ? JSON.parse(config.body) : config?.body;
            this.calls.push({
                url: String(url),
                method: config?.method || "GET",
                headers: config?.headers || {},
                body,
                signal: config?.signal,
            });

            const reply = this.replies.shift() || {
                status: 200,
                body: {
                    message: {
                        role: "assistant",
                        content:
                            "Echo: " +
                            (body?.messages
                                ? body.messages[body.messages.length - 1].content
                                : body?.content),
                    },
                    steps: [],
                    model: "test-model",
                },
            };

            // a scripted text/event-stream body, in two chunks so that the
            // parser sees a line split across reads
            const stream =
                typeof reply.sse === "string"
                    ? new ReadableStream<Uint8Array>({
                          start(controller) {
                              const encoder = new TextEncoder();
                              const half = Math.ceil(reply.sse!.length / 2);
                              controller.enqueue(encoder.encode(reply.sse!.slice(0, half)));
                              controller.enqueue(encoder.encode(reply.sse!.slice(half)));
                              controller.close();
                          },
                      })
                    : null;

            return {
                url: String(url),
                status: reply.status,
                body: stream,
                json: async () => {
                    if (typeof reply.body === "undefined") {
                        throw new Error("no json body");
                    }
                    return reply.body;
                },
            } as unknown as Response;
        };
    }

    restore() {
        global.fetch = this.originalFetch!;
    }
}

class FakeStorage {
    data = new Map<string, string>();
    getItem(key: string) {
        return this.data.has(key) ? this.data.get(key)! : null;
    }
    setItem(key: string, value: string) {
        this.data.set(key, value);
    }
    removeItem(key: string) {
        this.data.delete(key);
    }
}

const VALID_TOKEN = dummyJWT({ exp: Math.floor(Date.now() / 1000) + 3600 });

describe("ai()", function () {
    const net = new NetworkMock();
    let pb: Client;

    beforeEach(function () {
        net.init();
        net.calls = [];
        net.replies = [];
        pb = new Client("http://test");
    });

    afterEach(function () {
        pb.unuse("ai");
        net.restore();
        vi.unstubAllGlobals();
    });

    test("Should install as a plugin, attach client.ai and remove it on uninstall", function () {
        const client = pb.use(ai());

        assert.deepEqual(client.plugins, ["ai"]);
        assert.isFunction(client.ai.chat);
        assert.isFunction(client.ai.conversation);

        client.unuse("ai");
        assert.isUndefined((client as any).ai);
    });

    test("Should post the messages and options to /api/ai/chat through client.send", async function () {
        const client = pb.use(ai());
        pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);
        const seen: Array<string> = [];
        pb.hooks.beforeSend.add((url) => {
            seen.push(url);
        });

        const messages: Array<AiMessage> = [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Hello" },
        ];
        const controller = new AbortController();
        const reply = await client.ai.chat(messages, {
            model: "@cf/meta/llama-3.1-8b-instruct",
            tools: true,
            maxSteps: 3,
            signal: controller.signal,
        });

        assert.lengthOf(net.calls, 1);
        assert.equal(net.calls[0].url, "http://test/api/ai/chat");
        assert.equal(net.calls[0].method, "POST");
        assert.equal(net.calls[0].headers["Content-Type"], "application/json");
        assert.equal(net.calls[0].headers["Authorization"], VALID_TOKEN);
        assert.deepEqual(net.calls[0].body, {
            messages,
            model: "@cf/meta/llama-3.1-8b-instruct",
            tools: true,
            maxSteps: 3,
        });
        assert.equal(net.calls[0].signal, controller.signal);
        assert.deepEqual(seen, ["http://test/api/ai/chat"]);

        assert.deepEqual(reply, {
            message: { role: "assistant", content: "Echo: Hello" },
            steps: [],
            model: "test-model",
        });

        // without options only the messages are sent; the plugin's defaults fill in
        await client.ai.chat([{ role: "user", content: "Again" }]);
        assert.deepEqual(net.calls[1].body, {
            messages: [{ role: "user", content: "Again" }],
        });
        client.unuse("ai");
        pb.use(ai({ model: "default-model", maxSteps: 1 }));
        await (pb as any).ai.chat([{ role: "user", content: "Third" }], { maxSteps: 5 });
        assert.deepEqual(net.calls[2].body, {
            messages: [{ role: "user", content: "Third" }],
            model: "default-model",
            maxSteps: 5,
        });
    });

    test("Should pass the steps and model the route answers", async function () {
        const client = pb.use(ai());
        const body: AiReply = {
            message: { role: "assistant", content: "3 posts" },
            steps: [
                { tool: "list_records", arguments: { collection: "posts" }, result: [1, 2, 3] },
            ],
            model: "test-model",
        };
        net.replies = [{ status: 200, body }];

        const reply = await client.ai.chat([{ role: "user", content: "How many posts?" }]);
        assert.deepEqual(reply, body);
    });

    test("Should throw the ClientResponseError of a 503 when Workers AI is not bound", async function () {
        const client = pb.use(ai());
        net.replies = [{ status: 503, body: { message: "Workers AI is not bound." } }];

        try {
            await client.ai.chat([{ role: "user", content: "Hello" }]);
            assert.fail("expected a throw");
        } catch (err: any) {
            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 503);
            assert.equal(err.response.message, "Workers AI is not bound.");
            assert.equal(err.url, "http://test/api/ai/chat");
        }
    });

    describe("conversation()", function () {
        test("Should keep the history and send it whole each time", async function () {
            const client = pb.use(ai());
            const chat = client.ai.conversation({ system: "Be brief." });

            assert.deepEqual(chat.messages, [{ role: "system", content: "Be brief." }]);

            const first = await chat.send("Hello");
            assert.equal(first.message.content, "Echo: Hello");
            assert.deepEqual(net.calls[0].body.messages, [
                { role: "system", content: "Be brief." },
                { role: "user", content: "Hello" },
            ]);
            assert.deepEqual(chat.messages, [
                { role: "system", content: "Be brief." },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Echo: Hello" },
            ]);

            await chat.send("And again");
            assert.lengthOf(net.calls[1].body.messages, 4);
            assert.lengthOf(chat.messages, 5);

            // a refused turn leaves the history as it was
            net.replies = [{ status: 503, body: { message: "Workers AI is not bound." } }];
            await chat.send("Lost").catch(() => {});
            assert.lengthOf(chat.messages, 5);

            chat.reset();
            assert.deepEqual(chat.messages, [{ role: "system", content: "Be brief." }]);
        });

        test("Should persist the history in sessionStorage under the key and read it back", async function () {
            const store = new FakeStorage();
            vi.stubGlobal("sessionStorage", store);

            const client = pb.use(ai({ persist: true }));
            const chat = client.ai.conversation({ key: "chat:support" });
            await chat.send("Hello");

            assert.deepEqual(JSON.parse(store.getItem("chat:support")!), [
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Echo: Hello" },
            ]);
            assert.isNull(store.getItem("vb_ai_conversation"));

            // a new page picks the history up
            const again = client.ai.conversation({ key: "chat:support" });
            assert.deepEqual(again.messages, chat.messages);
            await again.send("More");
            assert.lengthOf(net.calls[1].body.messages, 3);

            again.reset();
            assert.isNull(store.getItem("chat:support"));
            assert.deepEqual(again.messages, []);

            // the default key, and nothing persisted without the option
            const other = client.ai.conversation();
            await other.send("Default");
            assert.isNotNull(store.getItem("vb_ai_conversation"));
            client.unuse("ai");
            store.data.clear();
            const plain = pb.use(ai()).ai.conversation();
            await plain.send("Memory only");
            assert.equal(store.data.size, 0);
            assert.lengthOf(plain.messages, 2);
        });
    });

    describe("conversations", function () {
        const record: AiConversationRecord = {
            id: "c1",
            title: "Support",
            model: "test-model",
            system: "Be brief.",
            tools: true,
            lastMessageAt: "",
            user: "u1",
        };
        const stored: Array<AiMessageRecord> = [
            { id: "m1", role: "user", content: "Hello", steps: [], tokens: null, created: "2026-09-11 08:00:00.000Z" },
            { id: "m2", role: "assistant", content: "Hi", steps: [], tokens: null, created: "2026-09-11 08:00:01.000Z" },
        ];
        const answer = {
            message: { role: "assistant", content: "Sure" },
            steps: [{ tool: "list_records", arguments: { collection: "posts" }, result: 3 }],
            model: "test-model",
            conversation: { ...record, lastMessageAt: "2026-09-11 08:01:00.000Z" },
        };

        test("Should create, list, get and remove through client.send", async function () {
            const client = pb.use(ai());
            pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);
            const seen: Array<string> = [];
            pb.hooks.beforeSend.add((url) => {
                seen.push(url);
            });

            net.replies = [
                { status: 200, body: record },
                { status: 200, body: { ...record, id: "c2", title: "" } },
                { status: 200, body: { page: 2, perPage: 5, totalItems: 7, totalPages: 2, items: [record] } },
                { status: 200, body: { page: 1, perPage: 30, totalItems: 1, totalPages: 1, items: [record] } },
                { status: 200, body: { ...record, messages: stored } },
                { status: 204 },
            ];

            const created = await client.ai.conversations.create({
                title: "Support",
                model: "test-model",
                system: "Be brief.",
                tools: true,
            });
            assert.deepEqual(created, record);
            assert.equal(net.calls[0].url, "http://test/api/ai/conversations");
            assert.equal(net.calls[0].method, "POST");
            assert.equal(net.calls[0].headers["Authorization"], VALID_TOKEN);
            assert.deepEqual(net.calls[0].body, {
                title: "Support",
                model: "test-model",
                system: "Be brief.",
                tools: true,
            });

            // without options an empty body goes
            await client.ai.conversations.create();
            assert.deepEqual(net.calls[1].body, {});

            const page = await client.ai.conversations.list({ page: 2, perPage: 5 });
            assert.equal(page.totalItems, 7);
            assert.equal(net.calls[2].method, "GET");
            assert.equal(net.calls[2].url, "http://test/api/ai/conversations?page=2&perPage=5");
            await client.ai.conversations.list();
            assert.equal(net.calls[3].url, "http://test/api/ai/conversations");

            const detail = await client.ai.conversations.get("c1");
            assert.deepEqual(detail, { ...record, messages: stored });
            assert.equal(net.calls[4].url, "http://test/api/ai/conversations/c1");
            assert.equal(net.calls[4].method, "GET");

            const gone = await client.ai.conversations.remove("c1");
            assert.isUndefined(gone);
            assert.equal(net.calls[5].url, "http://test/api/ai/conversations/c1");
            assert.equal(net.calls[5].method, "DELETE");

            assert.lengthOf(seen, 6);

            // anonymous callers get 401, thrown as the usual error
            net.replies = [{ status: 401, body: { message: "The request requires valid record authorization token." } }];
            try {
                await client.ai.conversations.list();
                assert.fail("expected a throw");
            } catch (err: any) {
                assert.instanceOf(err, ClientResponseError);
                assert.equal(err.status, 401);
            }
        });

        test("Should open a conversation and send one turn at a time, appending to messages", async function () {
            const client = pb.use(ai());
            net.replies = [
                { status: 200, body: { ...record, messages: stored } },
                { status: 200, body: answer },
            ];

            const chat = await client.ai.conversations.open("c1");
            assert.equal(chat.id, "c1");
            assert.deepEqual(chat.record, record);
            assert.deepEqual(chat.messages, stored);
            assert.notStrictEqual(chat.messages, stored);

            const controller = new AbortController();
            const reply = await chat.send("Count the posts", { maxSteps: 2, signal: controller.signal });
            assert.deepEqual(reply, answer);
            assert.equal(net.calls[1].url, "http://test/api/ai/conversations/c1/messages");
            assert.equal(net.calls[1].method, "POST");
            assert.deepEqual(net.calls[1].body, { content: "Count the posts", maxSteps: 2 });
            assert.equal(net.calls[1].signal, controller.signal);

            assert.lengthOf(chat.messages, 4);
            assert.include(chat.messages[2], { id: "", role: "user", content: "Count the posts" });
            assert.include(chat.messages[3], { id: "", role: "assistant", content: "Sure" });
            assert.deepEqual(chat.messages[3].steps, answer.steps);
            assert.equal(chat.record.lastMessageAt, "2026-09-11 08:01:00.000Z");

            // only the content goes without options
            await chat.send("Again");
            assert.deepEqual(net.calls[2].body, { content: "Again" });
            assert.lengthOf(chat.messages, 6);

            // a refused turn leaves the history as it was
            net.replies = [{ status: 503, body: { message: "Workers AI is not bound." } }];
            await chat.send("Lost").catch(() => {});
            assert.lengthOf(chat.messages, 6);

            // refresh replaces the history in place with what the server has
            const before = chat.messages;
            net.replies = [{ status: 200, body: { ...record, title: "Renamed", messages: stored } }];
            const fresh = await chat.refresh();
            assert.equal(fresh.title, "Renamed");
            assert.strictEqual(chat.messages, before);
            assert.deepEqual(chat.messages, stored);

            // remove deletes it
            net.replies = [{ status: 204 }];
            await chat.remove();
            assert.equal(net.calls[net.calls.length - 1].method, "DELETE");
            assert.equal(net.calls[net.calls.length - 1].url, "http://test/api/ai/conversations/c1");
        });

        test("Should start a conversation: create it and open it empty", async function () {
            const client = pb.use(ai());
            net.replies = [{ status: 200, body: { ...record, id: "c9" } }];

            const chat = await client.ai.conversations.start({ title: "Support" });
            assert.lengthOf(net.calls, 1);
            assert.deepEqual(net.calls[0].body, { title: "Support" });
            assert.equal(chat.id, "c9");
            assert.deepEqual(chat.messages, []);

            await chat.send("Hello");
            assert.equal(net.calls[1].url, "http://test/api/ai/conversations/c9/messages");
            assert.lengthOf(chat.messages, 2);
        });

        test("Should stream a turn: deltas, then the done event", async function () {
            const client = pb.use(ai());
            pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);
            const done = { done: true, ...answer };
            net.replies = [
                { status: 200, body: { ...record, messages: [] } },
                {
                    status: 200,
                    sse:
                        ": keep-alive\n\n" +
                        'data: {"delta": "Su"}\n\n' +
                        'data: {"delta": "re"}\r\n\r\n' +
                        "data: " + JSON.stringify(done) + "\n\n",
                },
            ];

            const chat = await client.ai.conversations.open("c1");
            const deltas: Array<string> = [];
            const controller = new AbortController();
            const reply = await chat.stream("Count the posts", {
                maxSteps: 2,
                signal: controller.signal,
                onDelta: (d) => deltas.push(d),
            });

            assert.deepEqual(deltas, ["Su", "re"]);
            assert.deepEqual(reply, answer);
            assert.equal(net.calls[1].url, "http://test/api/ai/conversations/c1/messages");
            assert.equal(net.calls[1].method, "POST");
            assert.deepEqual(net.calls[1].body, { content: "Count the posts", stream: true, maxSteps: 2 });
            assert.equal(net.calls[1].headers["Authorization"], VALID_TOKEN);
            assert.equal(net.calls[1].headers["Accept"], "text/event-stream");
            assert.equal(net.calls[1].headers["Content-Type"], "application/json");
            assert.equal(net.calls[1].signal, controller.signal);

            assert.lengthOf(chat.messages, 2);
            assert.include(chat.messages[0], { role: "user", content: "Count the posts" });
            assert.include(chat.messages[1], { role: "assistant", content: "Sure" });
            assert.equal(chat.record.lastMessageAt, "2026-09-11 08:01:00.000Z");

            // a done event without a message answers the joined deltas
            net.replies = [
                { status: 200, sse: 'data: {"delta": "A"}\n\ndata: {"delta": "B"}\n\ndata: {"done": true, "model": "m"}\n\n' },
            ];
            const joined = await chat.stream("More");
            assert.deepEqual(joined.message, { role: "assistant", content: "AB" });
            assert.deepEqual(joined.steps, []);
            assert.lengthOf(chat.messages, 4);
        });

        test("Should reject a stream on the error event, a refused request and a cut stream", async function () {
            const client = pb.use(ai());
            net.replies = [
                { status: 200, body: { ...record, messages: [] } },
                { status: 200, sse: 'data: {"delta": "Su"}\n\ndata: {"error": "model timed out"}\n\n' },
                { status: 401, body: { message: "The request requires valid record authorization token." } },
                { status: 200, sse: 'data: {"delta": "Su"}\n\n' },
            ];

            const chat = await client.ai.conversations.open("c1");
            const deltas: Array<string> = [];

            try {
                await chat.stream("Hello", { onDelta: (d) => deltas.push(d) });
                assert.fail("expected a throw");
            } catch (err: any) {
                assert.equal(err.message, "model timed out");
                assert.equal(err.url, "http://test/api/ai/conversations/c1/messages");
                assert.deepEqual(err.response, { message: "model timed out" });
            }
            assert.deepEqual(deltas, ["Su"]);
            assert.lengthOf(chat.messages, 0);

            try {
                await chat.stream("Hello");
                assert.fail("expected a throw");
            } catch (err: any) {
                assert.equal(err.status, 401);
                assert.equal(err.message, "The request requires valid record authorization token.");
            }

            try {
                await chat.stream("Hello");
                assert.fail("expected a throw");
            } catch (err: any) {
                assert.equal(err.message, "The stream ended without a done event.");
            }
            assert.lengthOf(chat.messages, 0);
        });

        test("Should subscribe to ai_messages filtered by the conversation and unsubscribe", async function () {
            const client = pb.use(ai());
            net.replies = [
                { status: 200, body: { ...record, messages: stored } },
                { status: 200, body: answer },
            ];

            const unsubscribe = vi.fn(async () => {});
            let fire: ((e: any) => void) | null = null;
            const subscribe = vi
                .spyOn(pb.collection("ai_messages"), "subscribe")
                .mockImplementation(async (_topic: string, callback: any) => {
                    fire = callback;
                    return unsubscribe;
                });

            const chat = await client.ai.conversations.open("c1");
            const seen: Array<[string, string]> = [];
            const stop = chat.subscribe((m, action) => {
                seen.push([action, m.id]);
            });
            await Promise.resolve();

            assert.equal(subscribe.mock.calls.length, 1);
            assert.equal(subscribe.mock.calls[0][0], "*");
            assert.deepEqual(subscribe.mock.calls[0][2], { filter: 'conversation = "c1"' });
            assert.isFunction(fire);

            // a message of another conversation is ignored
            fire!({ action: "create", record: { id: "x1", conversation: "other", role: "user", content: "No" } });
            assert.lengthOf(chat.messages, 2);
            assert.deepEqual(seen, []);

            // a reply landing from another tab reaches messages
            const landed = { id: "m3", conversation: "c1", role: "assistant", content: "From elsewhere", steps: [], tokens: null, created: "x" };
            fire!({ action: "create", record: landed });
            assert.lengthOf(chat.messages, 3);
            assert.deepEqual(chat.messages[2], landed);
            assert.deepEqual(seen, [["create", "m3"]]);

            // the stored record of a turn sent here replaces the local echo
            await chat.send("Count the posts");
            assert.lengthOf(chat.messages, 5);
            assert.equal(chat.messages[3].id, "");
            fire!({ action: "create", record: { ...landed, id: "m4", role: "user", content: "Count the posts" } });
            fire!({ action: "create", record: { ...landed, id: "m5", role: "assistant", content: "Sure" } });
            assert.lengthOf(chat.messages, 5);
            assert.equal(chat.messages[3].id, "m4");
            assert.equal(chat.messages[4].id, "m5");

            // update and delete by id; a repeated create is not duplicated
            fire!({ action: "update", record: { ...landed, content: "Edited" } });
            assert.equal(chat.messages[2].content, "Edited");
            fire!({ action: "create", record: { ...landed, content: "Edited" } });
            assert.lengthOf(chat.messages, 5);
            fire!({ action: "delete", record: landed });
            assert.lengthOf(chat.messages, 4);
            assert.deepEqual(seen.map((s) => s[0]), ["create", "create", "create", "update", "create", "delete"]);

            // the returned function unsubscribes, once, and later events are ignored
            assert.equal(unsubscribe.mock.calls.length, 0);
            stop();
            stop();
            assert.equal(unsubscribe.mock.calls.length, 1);
            fire!({ action: "create", record: { ...landed, id: "m6" } });
            assert.lengthOf(chat.messages, 4);
        });
    });

    describe("mountChat", function () {
        const record: AiConversationRecord = {
            id: "c1",
            title: "",
            model: "test-model",
            system: "",
            tools: true,
            lastMessageAt: "",
            user: "u1",
        };
        const answer = {
            message: { role: "assistant", content: "Three" },
            steps: [{ tool: "posts_list", arguments: { collection: "posts" }, result: 3 }],
            model: "test-model",
            conversation: record,
        };
        const stored: Array<AiMessageRecord> = [
            { id: "m1", role: "user", content: "Hello", steps: [], tokens: null, created: "a" },
            { id: "m2", role: "assistant", content: "Hi", steps: [], tokens: null, created: "b" },
        ];

        let host: HTMLElement;

        beforeEach(function () {
            document.body.innerHTML = '<div id="chat"></div>';
            host = document.getElementById("chat")!;
        });

        const q = (selector: string) =>
            host.querySelector(selector) as HTMLElement | null;

        /** the thread as [role, text] pairs, the greeting included */
        const thread = () =>
            Array.from(host.querySelectorAll(".vb-chat-message")).map((el) => [
                el.getAttribute("data-vb-role"),
                (el.querySelector(".vb-chat-content") as HTMLElement).textContent,
            ]);

        function settle(): Promise<void> {
            return new Promise((resolve) => setTimeout(resolve, 0));
        }

        function type(text: string): void {
            (q(".vb-chat-input") as HTMLTextAreaElement).value = text;
        }

        /** answers whether the key was left alone (the newline not prevented) */
        function fireKey(key: string, init: any = {}): boolean {
            return q(".vb-chat-input")!.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                }),
            );
        }

        test("Should mount the elements, start a conversation and send a turn", async function () {
            const client = pb.use(ai());
            pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);
            net.replies = [
                { status: 200, body: record },
                { status: 200, body: answer },
            ];

            const chat = mountChat(host, {
                client,
                system: "You help with the docs.",
                greeting: "Ask me about the docs.",
                placeholder: "Say something",
                stream: false,
                realtime: false,
            });

            assert.equal(chat.element.className, "vb-chat");
            assert.equal(chat.element.parentElement, host);
            assert.isOk(q(".vb-chat-messages"));
            assert.isOk(q(".vb-chat-form"));
            assert.equal((q(".vb-chat-input") as HTMLTextAreaElement).placeholder, "Say something");
            assert.equal(q(".vb-chat-send")!.textContent, "Send");
            assert.deepEqual(thread(), [["assistant", "Ask me about the docs."]]);

            await settle();
            assert.equal(net.calls[0].url, "http://test/api/ai/conversations");
            assert.equal(net.calls[0].method, "POST");
            assert.deepEqual(net.calls[0].body, { system: "You help with the docs." });
            assert.equal(chat.conversation!.id, "c1");

            // Enter sends what the box holds, and the turn shows before the
            // instance has answered
            type("How many posts?");
            const kept = fireKey("Enter");
            assert.isFalse(kept);
            assert.deepEqual(thread(), [
                ["assistant", "Ask me about the docs."],
                ["user", "How many posts?"],
                ["assistant", ""],
            ]);
            assert.equal((q(".vb-chat-input") as HTMLTextAreaElement).value, "");
            assert.isTrue((q(".vb-chat-send") as HTMLButtonElement).disabled);

            await settle();
            assert.equal(net.calls[1].url, "http://test/api/ai/conversations/c1/messages");
            assert.deepEqual(net.calls[1].body, { content: "How many posts?" });
            assert.deepEqual(thread(), [
                ["assistant", "Ask me about the docs."],
                ["user", "How many posts?"],
                ["assistant", "Three"],
            ]);
            assert.isFalse((q(".vb-chat-send") as HTMLButtonElement).disabled);

            // the tool calls are one line to open, not something hidden
            const steps = host.querySelector(".vb-chat-steps") as HTMLDetailsElement;
            assert.isOk(steps);
            assert.isFalse(steps.open);
            assert.equal(steps.querySelector("summary")!.textContent, "used posts_list");
            assert.include(
                (steps.querySelector(".vb-chat-step") as HTMLElement).textContent!,
                'posts_list({"collection":"posts"})',
            );

            // Shift+Enter leaves the newline alone, and an empty box sends nothing
            type("a line");
            assert.isTrue(fireKey("Enter", { shiftKey: true }));
            type("   ");
            assert.isFalse(fireKey("Enter"));
            await settle();
            assert.lengthOf(net.calls, 2);
            chat.destroy();
        });

        test("Should stream a turn and append the deltas into the last message", async function () {
            const client = pb.use(ai());
            const done = { done: true, ...answer, steps: [] };
            net.replies = [
                { status: 200, body: record },
                {
                    status: 200,
                    sse:
                        'data: {"delta": "Th"}\n\n' +
                        'data: {"delta": "ree"}\n\n' +
                        "data: " + JSON.stringify(done) + "\n\n",
                },
            ];

            const chat = mountChat(host, { client, realtime: false });
            await settle();

            await chat.send("How many posts?");
            assert.deepEqual(net.calls[1].body, { content: "How many posts?", stream: true });
            assert.equal(net.calls[1].headers["Accept"], "text/event-stream");
            assert.deepEqual(thread(), [
                ["user", "How many posts?"],
                ["assistant", "Three"],
            ]);
            chat.destroy();
        });

        test("Should show each delta as it arrives rather than the answer at the end", async function () {
            const client = pb.use(ai());
            net.replies = [{ status: 200, body: record }];

            const seen: Array<string> = [];
            const answering: any = {
                id: "c1",
                record,
                messages: [] as Array<AiMessageRecord>,
                async stream(content: string, options: any) {
                    for (const delta of ["Th", "ree"]) {
                        options.onDelta(delta);
                        seen.push(thread().map((t) => t[1]).join("|"));
                    }
                    answering.messages.push(
                        { id: "", role: "user", content, steps: [], tokens: null, created: "" },
                        { id: "", role: "assistant", content: "Three", steps: [], tokens: null, created: "" },
                    );
                    return answer;
                },
                subscribe: () => () => {},
            };
            vi.spyOn(client.ai.conversations, "start").mockResolvedValue(answering);

            const chat = mountChat(host, { client, realtime: false });
            await chat.send("How many posts?");

            assert.deepEqual(seen, ["How many posts?|Th", "How many posts?|Three"]);
            assert.deepEqual(thread(), [
                ["user", "How many posts?"],
                ["assistant", "Three"],
            ]);
            chat.destroy();
        });

        test("Should say in the thread what the instance refused, and keep the text", async function () {
            const client = pb.use(ai());
            const errors: Array<any> = [];
            const refusal = {
                status: 401,
                body: { message: "The request requires valid record authorization token." },
            };
            net.replies = [refusal];

            const chat = mountChat(host, {
                client,
                realtime: false,
                onError: (err) => errors.push(err),
            });
            await settle();

            const notice = q(".vb-chat-notice")!;
            assert.isOk(notice);
            assert.equal(
                notice.textContent,
                "Sign in to chat: The request requires valid record authorization token.",
            );
            assert.isNull(chat.conversation);
            assert.lengthOf(errors, 1);
            assert.equal(errors[0].status, 401);

            // a turn sent anyway says so too and leaves the text in the box
            net.replies = [refusal];
            await chat.send("Hello");
            assert.lengthOf(host.querySelectorAll(".vb-chat-notice"), 2);
            assert.deepEqual(thread(), []);
            assert.equal((q(".vb-chat-input") as HTMLTextAreaElement).value, "Hello");

            // and so does a turn the instance refuses mid-conversation
            net.replies = [
                { status: 200, body: record },
                { status: 503, body: { message: "Workers AI is not bound." } },
            ];
            type("");
            await chat.send("Hello again");
            assert.equal(
                host.querySelectorAll(".vb-chat-notice")[2].textContent,
                "Workers AI is not bound.",
            );
            assert.deepEqual(thread(), []);
            assert.equal((q(".vb-chat-input") as HTMLTextAreaElement).value, "Hello again");
            chat.destroy();
        });

        test("Should open a conversation, follow it over realtime and clean up on destroy", async function () {
            const client = pb.use(ai());
            const unsubscribe = vi.fn(async () => {});
            const subscribe = vi
                .spyOn(pb.collection("ai_messages"), "subscribe")
                .mockImplementation(async () => unsubscribe);
            net.replies = [{ status: 200, body: { ...record, messages: stored } }];

            const chat = mountChat(host, { client, conversation: "c1" });
            await settle();

            assert.equal(net.calls[0].url, "http://test/api/ai/conversations/c1");
            assert.equal(net.calls[0].method, "GET");
            assert.deepEqual(thread(), [
                ["user", "Hello"],
                ["assistant", "Hi"],
            ]);

            // a reply landing from another tab reaches the thread
            assert.equal(subscribe.mock.calls.length, 1);
            const fire = subscribe.mock.calls[0][1] as any;
            fire({
                action: "create",
                record: {
                    id: "m3",
                    conversation: "c1",
                    role: "assistant",
                    content: "From elsewhere",
                    steps: [],
                    tokens: null,
                    created: "c",
                },
            });
            assert.deepEqual(thread()[2], ["assistant", "From elsewhere"]);

            chat.destroy();
            await settle();
            assert.equal(unsubscribe.mock.calls.length, 1);
            assert.equal(host.innerHTML, "");
            chat.destroy(); // twice is no different
            assert.equal(unsubscribe.mock.calls.length, 1);
        });
    });
});
