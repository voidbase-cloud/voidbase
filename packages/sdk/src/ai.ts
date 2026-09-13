// The chat helper, as a plugin: @voidbase-cloud/sdk/ai
//
// Installed, it attaches `client.ai`: `chat(messages)` posts to the
// instance's /api/ai/chat route through client.send, so the auth token and
// the hook lists apply, and `conversation()` keeps a history in memory (and
// in sessionStorage when `persist` is set) that `send(text)` grows by a turn
// each time. The route answers 503 with a message when Workers AI is not
// bound to the instance; that arrives as the ClientResponseError any other
// request would throw. `conversations` are the ones the instance keeps as
// records for the signed-in user (/api/ai/conversations): `open(id)` and
// `start()` answer a ServerConversation whose `send` and `stream` post one
// turn at a time, the history living on the server, and whose `subscribe`
// follows the ai_messages collection over realtime. The plugin imports only
// types from the core package, so this entry carries no second copy of the
// client.

import type Client from "@voidbase-cloud/sdk";
import type { Plugin } from "@voidbase-cloud/sdk";

export type AiRole = "system" | "user" | "assistant";

/**
 * One turn of a chat, as sent and as answered.
 */
export interface AiMessage {
    role: AiRole;
    content: string;
}

/**
 * One tool call the model made on the way to its answer.
 */
export interface AiStep {
    tool: string;
    arguments: { [key: string]: any };
    result: any;
}

/**
 * What /api/ai/chat answers.
 */
export interface AiReply {
    message: AiMessage & { role: "assistant" };
    steps: Array<AiStep>;
    model: string;
}

export interface AiChatOptions {
    /**
     * The model to answer with (default: the instance's).
     */
    model?: string;

    /**
     * Whether the model may call the instance's tools (default: the
     * instance's).
     */
    tools?: boolean;

    /**
     * How many tool steps the model may take (default: the instance's).
     */
    maxSteps?: number;

    /**
     * Aborts the request (the signal `client.send` accepts). Typed through
     * RequestInit so that the declaration does not pick the AbortSignal of
     * @types/node, which the declaration bundler cannot reference.
     */
    signal?: RequestInit["signal"];
}

export interface AiOptions extends Omit<AiChatOptions, "signal"> {
    /**
     * Keep every conversation's history in sessionStorage under its key,
     * so that it survives a reload (default: false).
     */
    persist?: boolean;

    /**
     * The sessionStorage key of a conversation created without one
     * (default: "vb_ai_conversation").
     */
    key?: string;
}

export interface AiConversationOptions {
    /**
     * The sessionStorage key of this conversation, when `persist` is set.
     */
    key?: string;

    /**
     * A system message that opens the conversation (kept by `reset()`).
     */
    system?: string;
}

/**
 * A chat with a history.
 */
export interface AiConversation {
    /**
     * Every turn so far, oldest first; the array `send` grows.
     */
    readonly messages: Array<AiMessage>;

    /**
     * Adds the user's text to the history, asks the model, adds its answer
     * and answers the reply. A refused request leaves the history as it was.
     */
    send(text: string, options?: AiChatOptions): Promise<AiReply>;

    /**
     * Forgets the history (except the system message).
     */
    reset(): void;
}

/**
 * A conversation the instance keeps as a record of `ai_conversations`.
 */
export interface AiConversationRecord {
    id: string;
    title: string;
    model: string;
    system: string;
    tools: boolean;
    lastMessageAt: string;
    user: string;
    created?: string;
    updated?: string;
    [key: string]: any;
}

/**
 * One turn of a server-side conversation, as `ai_messages` stores it. A
 * turn `send` or `stream` appended locally has an empty `id` and `created`
 * until `refresh()` or a realtime event brings the stored record.
 */
export interface AiMessageRecord {
    id: string;
    role: AiRole;
    content: string;
    steps: Array<AiStep>;
    tokens: any;
    created: string;
    conversation?: string;
    [key: string]: any;
}

/**
 * What GET /api/ai/conversations/:id answers: the record plus its messages,
 * oldest first.
 */
export interface AiConversationDetail extends AiConversationRecord {
    messages: Array<AiMessageRecord>;
}

/**
 * What GET /api/ai/conversations answers.
 */
export interface AiConversationsList {
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
    items: Array<AiConversationRecord>;
}

/**
 * What POST /api/ai/conversations/:id/messages answers: the reply plus the
 * conversation record as the turn left it.
 */
export interface AiServerReply extends AiReply {
    conversation: AiConversationRecord;
}

export interface AiConversationCreateOptions {
    title?: string;
    model?: string;
    system?: string;
    tools?: boolean;
}

export interface AiConversationsListOptions {
    page?: number;
    perPage?: number;
}

export interface AiServerSendOptions {
    /**
     * How many tool steps the model may take (default: the instance's).
     */
    maxSteps?: number;

    /**
     * Aborts the request.
     */
    signal?: RequestInit["signal"];
}

export interface AiServerStreamOptions extends AiServerSendOptions {
    /**
     * Called with each chunk of the answer as it streams in.
     */
    onDelta?: (delta: string) => void;
}

/**
 * A conversation that lives on the server; one turn goes with every request.
 */
export interface ServerConversation {
    readonly id: string;

    /**
     * The conversation record as last fetched or answered.
     */
    readonly record: AiConversationRecord;

    /**
     * Every turn so far, oldest first; the array `send`, `stream`,
     * `refresh` and realtime events grow or replace in place.
     */
    readonly messages: Array<AiMessageRecord>;

    /**
     * Fetches the record and its messages again and answers the record.
     */
    refresh(): Promise<AiConversationRecord>;

    /**
     * Posts the user's text, appends it and the model's answer to
     * `messages` and answers the reply. A refused turn leaves `messages`
     * as they were.
     */
    send(content: string, options?: AiServerSendOptions): Promise<AiServerReply>;

    /**
     * Posts the user's text with `stream: true`, calls `onDelta` with each
     * chunk of the answer, appends both turns once the done event arrives
     * and answers the reply; rejects on the stream's error event.
     */
    stream(content: string, options?: AiServerStreamOptions): Promise<AiServerReply>;

    /**
     * Follows the conversation's messages over realtime (a reply landing
     * from another tab reaches `messages`); the returned function
     * unsubscribes.
     */
    subscribe(callback: (message: AiMessageRecord, action: string) => void): () => void;

    /**
     * Deletes the conversation on the server.
     */
    remove(): Promise<void>;
}

/**
 * The server-side conversations, as `client.ai.conversations`.
 */
export interface AiConversations {
    create(options?: AiConversationCreateOptions): Promise<AiConversationRecord>;
    list(options?: AiConversationsListOptions): Promise<AiConversationsList>;
    get(id: string): Promise<AiConversationDetail>;
    remove(id: string): Promise<void>;

    /**
     * Fetches an existing conversation and its messages.
     */
    open(id: string): Promise<ServerConversation>;

    /**
     * Creates a conversation and opens it.
     */
    start(options?: AiConversationCreateOptions): Promise<ServerConversation>;
}

/**
 * The controller attached as `client.ai`.
 */
export interface AiController {
    /**
     * Asks the model to answer the messages; every request is its own
     * (no auto-cancellation between chats).
     */
    chat(messages: Array<AiMessage>, options?: AiChatOptions): Promise<AiReply>;

    /**
     * A chat that keeps its history.
     */
    conversation(options?: AiConversationOptions): AiConversation;

    /**
     * The conversations the instance keeps for the signed-in user.
     */
    readonly conversations: AiConversations;
}

/**
 * A client with the ai plugin installed (what `client.use(ai())` answers).
 */
export type AiClient<T extends Client = Client> = T & {
    ai: AiController;
};

const DEFAULT_KEY = "vb_ai_conversation";
const CONVERSATIONS = "/api/ai/conversations";
const MESSAGES_COLLECTION = "ai_messages";

function storage(): Storage | null {
    try {
        return typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch (_) {
        return null; // access denied (a sandboxed frame)
    }
}

function isMessage(value: any): value is AiMessage {
    return (
        !!value &&
        typeof value === "object" &&
        typeof value.role === "string" &&
        typeof value.content === "string"
    );
}

/**
 * Reads a text/event-stream body: calls `onEvent` with each parsed `data:`
 * payload, in order, and answers when the body ends. A payload that is not
 * JSON is skipped; an event of several `data:` lines is joined with "\n".
 */
async function readEvents(
    response: Response,
    onEvent: (event: any) => boolean,
): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    let data: Array<string> = [];

    const dispatch = (): boolean => {
        if (!data.length) {
            return false;
        }
        const raw = data.join("\n");
        data = [];
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            return false;
        }
        return onEvent(parsed);
    };

    const feed = (chunk: string): boolean => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).replace(/\r$/, "");
            buffer = buffer.slice(at + 1);
            if (line === "") {
                if (dispatch()) {
                    return true;
                }
            } else if (line.startsWith("data:")) {
                data.push(line.slice(5).replace(/^ /, ""));
            }
            // comments and other fields are ignored
        }
        return false;
    };

    const body: any = response.body;
    if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (feed(decoder.decode(value, { stream: true }))) {
                    return;
                }
            }
        } finally {
            try {
                reader.releaseLock();
            } catch (_) {}
        }
        feed(decoder.decode());
    } else {
        feed(await response.text());
    }

    // a last event without a trailing blank line
    if (buffer !== "") {
        feed("\n");
    }
    dispatch();
}

function sameTurn(a: AiMessageRecord, b: AiMessageRecord): boolean {
    return a.role === b.role && a.content === b.content;
}

/**
 * Puts a stored message into the history: replaces the one with its id, or
 * the local echo of the same turn, or appends it.
 */
function merge(messages: Array<AiMessageRecord>, record: AiMessageRecord): void {
    const byId = record.id ? messages.findIndex((m) => m.id === record.id) : -1;
    if (byId >= 0) {
        messages[byId] = record;
        return;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].id && sameTurn(messages[i], record)) {
            messages[i] = record;
            return;
        }
    }
    messages.push(record);
}

function echo(message: AiMessage, steps: Array<AiStep> = []): AiMessageRecord {
    return {
        id: "",
        role: message.role,
        content: message.content,
        steps,
        tokens: null,
        created: "",
    };
}

class Controller implements AiController {
    readonly conversations: AiConversations;

    constructor(
        private client: Client,
        private options: AiOptions,
    ) {
        this.conversations = new Conversations(client);
    }

    async chat(messages: Array<AiMessage>, options: AiChatOptions = {}): Promise<AiReply> {
        const body: { [key: string]: any } = { messages };

        const model = options.model ?? this.options.model;
        if (typeof model !== "undefined") {
            body.model = model;
        }
        const tools = options.tools ?? this.options.tools;
        if (typeof tools !== "undefined") {
            body.tools = tools;
        }
        const maxSteps = options.maxSteps ?? this.options.maxSteps;
        if (typeof maxSteps !== "undefined") {
            body.maxSteps = maxSteps;
        }

        return this.client.send<AiReply>("/api/ai/chat", {
            method: "POST",
            body,
            signal: options.signal,
            requestKey: null,
        });
    }

    conversation(options: AiConversationOptions = {}): AiConversation {
        const key = options.key || this.options.key || DEFAULT_KEY;
        const store = this.options.persist ? storage() : null;
        const opening: Array<AiMessage> = options.system
            ? [{ role: "system", content: options.system }]
            : [];

        let messages: Array<AiMessage> = opening.slice();

        // what an earlier page left, when it fits
        if (store) {
            try {
                const raw = store.getItem(key);
                const parsed = raw ? JSON.parse(raw) : null;
                if (Array.isArray(parsed) && parsed.every(isMessage)) {
                    messages = parsed;
                }
            } catch (_) {}
        }

        const save = () => {
            try {
                store?.setItem(key, JSON.stringify(messages));
            } catch (_) {} // a full or read-only storage keeps the history in memory
        };

        const chat = (m: Array<AiMessage>, o?: AiChatOptions) => this.chat(m, o);

        return {
            get messages() {
                return messages;
            },
            async send(text: string, chatOptions?: AiChatOptions) {
                const asked = messages.concat([{ role: "user", content: text }]);
                const reply = await chat(asked, chatOptions);
                messages.push({ role: "user", content: text }, reply.message);
                save();
                return reply;
            },
            reset() {
                messages.length = 0;
                messages.push(...opening);
                if (store) {
                    try {
                        store.removeItem(key);
                    } catch (_) {}
                }
            },
        };
    }
}

class Conversations implements AiConversations {
    constructor(private client: Client) {}

    create(options: AiConversationCreateOptions = {}): Promise<AiConversationRecord> {
        const body: { [key: string]: any } = {};
        for (const key of ["title", "model", "system", "tools"] as const) {
            if (typeof options[key] !== "undefined") {
                body[key] = options[key];
            }
        }
        return this.client.send<AiConversationRecord>(CONVERSATIONS, {
            method: "POST",
            body,
            requestKey: null,
        });
    }

    list(options: AiConversationsListOptions = {}): Promise<AiConversationsList> {
        const query: { [key: string]: any } = {};
        if (typeof options.page !== "undefined") {
            query.page = options.page;
        }
        if (typeof options.perPage !== "undefined") {
            query.perPage = options.perPage;
        }
        return this.client.send<AiConversationsList>(CONVERSATIONS, {
            method: "GET",
            query,
            requestKey: null,
        });
    }

    get(id: string): Promise<AiConversationDetail> {
        return this.client.send<AiConversationDetail>(
            CONVERSATIONS + "/" + encodeURIComponent(id),
            { method: "GET", requestKey: null },
        );
    }

    async remove(id: string): Promise<void> {
        await this.client.send(CONVERSATIONS + "/" + encodeURIComponent(id), {
            method: "DELETE",
            requestKey: null,
        });
    }

    async open(id: string): Promise<ServerConversation> {
        const detail = await this.get(id);
        const { messages, ...record } = detail;
        return this.wrap(record, Array.isArray(messages) ? messages : []);
    }

    async start(options: AiConversationCreateOptions = {}): Promise<ServerConversation> {
        const record = await this.create(options);
        return this.wrap(record, []);
    }

    private wrap(
        initial: AiConversationRecord,
        history: Array<AiMessageRecord>,
    ): ServerConversation {
        const client = this.client;
        const conversations = this;
        const id = initial.id;
        const path = CONVERSATIONS + "/" + encodeURIComponent(id);
        const messages: Array<AiMessageRecord> = history.slice();
        let record: AiConversationRecord = initial;

        const settle = (content: string, reply: AiServerReply) => {
            messages.push(echo({ role: "user", content }));
            messages.push(echo(reply.message, reply.steps || []));
            if (reply.conversation && typeof reply.conversation === "object") {
                record = reply.conversation;
            }
        };

        return {
            get id() {
                return id;
            },
            get record() {
                return record;
            },
            get messages() {
                return messages;
            },

            async refresh() {
                const detail = await conversations.get(id);
                const { messages: fetched, ...rest } = detail;
                record = rest;
                messages.length = 0;
                if (Array.isArray(fetched)) {
                    messages.push(...fetched);
                }
                return record;
            },

            async send(content: string, options: AiServerSendOptions = {}) {
                const body: { [key: string]: any } = { content };
                if (typeof options.maxSteps !== "undefined") {
                    body.maxSteps = options.maxSteps;
                }
                const reply = await client.send<AiServerReply>(path + "/messages", {
                    method: "POST",
                    body,
                    signal: options.signal,
                    requestKey: null,
                });
                settle(content, reply);
                return reply;
            },

            async stream(content: string, options: AiServerStreamOptions = {}) {
                const body: { [key: string]: any } = { content, stream: true };
                if (typeof options.maxSteps !== "undefined") {
                    body.maxSteps = options.maxSteps;
                }
                const headers: { [key: string]: string } = {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream",
                    "Accept-Language": client.lang,
                };
                if (client.authStore.token) {
                    headers["Authorization"] = client.authStore.token;
                }
                const url = client.buildURL(path + "/messages");

                const response = await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: options.signal,
                });

                if (response.status < 200 || response.status >= 300) {
                    let data: any = {};
                    try {
                        data = await response.json();
                    } catch (_) {}
                    const err: any = new Error(
                        (data && data.message) || "Something went wrong.",
                    );
                    err.url = url;
                    err.status = response.status;
                    err.response = data || {};
                    throw err;
                }

                let reply: AiServerReply | null = null;
                let failure: string | null = null;
                let text = "";

                await readEvents(response, (event): boolean => {
                    if (!event || typeof event !== "object") {
                        return false;
                    }
                    if (typeof event.error !== "undefined") {
                        failure = String(event.error);
                        return true; // stop reading
                    }
                    if (typeof event.delta === "string") {
                        text += event.delta;
                        options.onDelta?.(event.delta);
                        return false;
                    }
                    if (event.done) {
                        reply = {
                            message: event.message || { role: "assistant", content: text },
                            steps: event.steps || [],
                            model: event.model,
                            conversation: event.conversation,
                        };
                        return true;
                    }
                    return false;
                });

                if (failure !== null) {
                    const err: any = new Error(failure);
                    err.url = url;
                    err.status = response.status;
                    err.response = { message: failure };
                    throw err;
                }
                if (!reply) {
                    throw new Error("The stream ended without a done event.");
                }

                settle(content, reply);
                return reply;
            },

            subscribe(callback) {
                let active = true;
                let release: (() => Promise<void>) | null = null;

                const pending = client
                    .collection<AiMessageRecord>(MESSAGES_COLLECTION)
                    .subscribe(
                        "*",
                        (e) => {
                            if (!active || !e.record || e.record.conversation !== id) {
                                return;
                            }
                            if (e.action === "delete") {
                                const at = messages.findIndex((m) => m.id === e.record.id);
                                if (at >= 0) {
                                    messages.splice(at, 1);
                                }
                            } else {
                                merge(messages, e.record);
                            }
                            callback(e.record, e.action);
                        },
                        { filter: 'conversation = "' + id + '"' },
                    );

                pending.then(
                    (fn) => {
                        release = fn;
                        if (!active) {
                            fn().catch(() => {});
                        }
                    },
                    () => {}, // a failed subscription is reported by the client
                );

                return () => {
                    if (!active) {
                        return;
                    }
                    active = false;
                    if (release) {
                        release().catch(() => {});
                    }
                };
            },

            remove() {
                return conversations.remove(id);
            },
        };
    }
}

/**
 * The chat plugin.
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { ai } from "@voidbase-cloud/sdk/ai";
 *
 * const pb = new PocketBase("https://example.com").use(ai({ persist: true }));
 *
 * const { message } = await pb.ai.chat([{ role: "user", content: "Hello" }]);
 *
 * const chat = pb.ai.conversation();
 * await chat.send("What is voidbase?");
 * chat.messages; // the user's turn and the assistant's
 *
 * const kept = await pb.ai.conversations.start({ title: "Support" });
 * await kept.stream("Hello", { onDelta: (d) => process.stdout.write(d) });
 * ```
 *
 * `client.unuse("ai")` removes `client.ai`; conversations already created
 * keep working.
 */
export function ai(options: AiOptions = {}): Plugin<{ ai: AiController }> {
    return {
        name: "ai",
        install(client: Client) {
            (client as AiClient).ai = new Controller(client, options);

            return () => {
                delete (client as any).ai;
            };
        },
    };
}

// --- the chat widget ---------------------------------------------------
//
// `mountChat(target, options)` builds a small chat over
// `client.ai.conversations`: a message list, a textarea and a Send button,
// with structural inline styles and `<prefix>-*` class names for the
// application to restyle, the way the editable plugin's toolbar does it.
// No framework, no markdown: what the model answers is set as text.

export interface ChatMountOptions {
    /**
     * The client to talk through; the ai plugin must be installed on it.
     */
    client: AiClient;

    /**
     * An existing conversation to open (default: one is started).
     */
    conversation?: string;

    /**
     * The system message, the model and whether tools may be called, for
     * the conversation this mount starts (ignored when it opens one).
     */
    system?: string;
    model?: string;
    tools?: boolean;

    /**
     * A first assistant line to show, the widget's own and never sent.
     */
    greeting?: string;

    /**
     * The textarea's placeholder (default: "Message").
     */
    placeholder?: string;

    /**
     * Whether a turn is streamed, its answer appearing as it arrives
     * (default: true).
     */
    stream?: boolean;

    /**
     * Whether to follow the conversation over realtime, so that a reply
     * landing from another tab appears here too (default: true).
     */
    realtime?: boolean;

    /**
     * Called with whatever the instance refused, besides the line the
     * thread shows.
     */
    onError?: (error: any) => void;

    /**
     * The first part of every class name (default: "vb-chat").
     */
    classPrefix?: string;
}

/**
 * What `mountChat` answers.
 */
export interface ChatMount {
    /**
     * The element the widget built inside the target.
     */
    readonly element: HTMLElement;

    /**
     * The conversation it talks through, once it is open.
     */
    readonly conversation: ServerConversation | null;

    /**
     * Sends a turn as the Send button does; resolves when it has landed
     * or the thread has said why it did not.
     */
    send(text: string): Promise<void>;

    /**
     * Takes the widget out of the page and unsubscribes.
     */
    destroy(): void;
}

function summarize(value: any): string {
    try {
        const json = JSON.stringify(value);
        return typeof json === "string" ? json : String(value);
    } catch (_) {
        return String(value);
    }
}

/**
 * Builds a chat in the given element (or the one a selector finds) over
 * the instance's conversations.
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { ai, mountChat } from "@voidbase-cloud/sdk/ai";
 *
 * const pb = new PocketBase("https://example.com").use(ai());
 *
 * const chat = mountChat("#chat", {
 *     client: pb,
 *     system: "You help with the docs.",
 *     greeting: "Ask me about the docs.",
 * });
 *
 * chat.destroy();
 * ```
 *
 * The conversation is opened (or started) as the widget mounts, so a
 * refusal, a 401 for an anonymous caller above all, is a line in the
 * thread rather than a throw. A turn that fails leaves its text in the
 * box.
 */
export function mountChat(
    target: Element | string,
    options: ChatMountOptions,
): ChatMount {
    const client = options.client;
    if (!client || !client.ai) {
        throw new Error(
            "mountChat needs a client with the ai plugin installed (client.use(ai())).",
        );
    }

    const host =
        typeof target === "string"
            ? typeof document !== "undefined"
                ? document.querySelector(target)
                : null
            : target;
    if (!host) {
        throw new Error("mountChat found no element to mount into.");
    }

    const doc = host.ownerDocument;
    const prefix = options.classPrefix || "vb-chat";
    const streaming = options.stream !== false;

    // --- the elements ---

    const root = doc.createElement("div");
    root.className = prefix;
    root.style.cssText = "display:flex;flex-direction:column;gap:8px;min-height:0";

    const list = doc.createElement("div");
    list.className = prefix + "-messages";
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "polite");
    list.style.cssText =
        "flex:1 1 auto;min-height:0;overflow-y:auto;" +
        "display:flex;flex-direction:column;gap:8px";

    const form = doc.createElement("form");
    form.className = prefix + "-form";
    form.style.cssText = "display:flex;gap:4px;align-items:flex-end";

    const input = doc.createElement("textarea");
    input.className = prefix + "-input";
    input.rows = 2;
    input.placeholder = options.placeholder || "Message";
    input.style.cssText = "flex:1 1 auto;min-width:0;font:inherit;resize:vertical";

    const button = doc.createElement("button");
    button.className = prefix + "-send";
    button.type = "submit";
    button.textContent = "Send";

    form.appendChild(input);
    form.appendChild(button);
    root.appendChild(list);
    root.appendChild(form);
    host.appendChild(root);

    // --- the thread ---

    /**
     * The lines that are the widget's own rather than the conversation's:
     * whatever the instance refused, under the turns so far.
     */
    const notices: Array<HTMLElement> = [];

    /**
     * The turn on its way: shown at once, and replaced by the stored one
     * when the instance answers.
     */
    let live: { user: HTMLElement; reply: HTMLElement; body: HTMLElement } | null = null;

    let conversation: ServerConversation | null = null;
    let opening: Promise<ServerConversation | null> | null = null;
    let unsubscribe: (() => void) | null = null;
    let pending: AbortController | null = null;
    let sending = false;
    let gone = false;

    /**
     * The widget's own first line, over the conversation's turns.
     */
    const greeting = options.greeting ? line("assistant", options.greeting) : null;

    function line(role: string, content: string, steps?: Array<AiStep>): HTMLElement {
        const node = doc.createElement("div");
        node.className = prefix + "-message " + prefix + "-" + role;
        node.setAttribute("data-vb-role", role);

        if (steps && steps.length) {
            // the tool calls are a line one can open, not something hidden
            const details = doc.createElement("details");
            details.className = prefix + "-steps";
            const summary = doc.createElement("summary");
            summary.textContent =
                "used " + steps.map((step) => step.tool).join(", ");
            details.appendChild(summary);
            for (const step of steps) {
                const one = doc.createElement("div");
                one.className = prefix + "-step";
                one.textContent =
                    step.tool +
                    "(" +
                    summarize(step.arguments) +
                    ") " +
                    summarize(step.result);
                details.appendChild(one);
            }
            node.appendChild(details);
        }

        const body = doc.createElement("div");
        body.className = prefix + "-content";
        body.style.cssText = "white-space:pre-wrap";
        body.textContent = content;
        node.appendChild(body);

        return node;
    }

    function paint(): void {
        if (gone) {
            return;
        }

        while (list.firstChild) {
            list.removeChild(list.firstChild);
        }

        if (greeting) {
            list.appendChild(greeting);
        }

        if (conversation) {
            for (const message of conversation.messages) {
                if (message.role === "system") {
                    continue; // the instance's instructions are not a turn
                }
                list.appendChild(line(message.role, message.content, message.steps));
            }
        }

        for (const note of notices) {
            list.appendChild(note);
        }

        if (live) {
            list.appendChild(live.user);
            list.appendChild(live.reply);
        }

        list.scrollTop = list.scrollHeight;
    }

    function notice(text: string): void {
        const node = doc.createElement("div");
        node.className = prefix + "-notice";
        node.setAttribute("role", "status");
        node.textContent = text;
        notices.push(node);
        paint();
    }

    function refused(error: any): void {
        const message =
            (error && (error.response?.message || error.message)) ||
            "Something went wrong.";
        notice(
            error && error.status === 401
                ? // the conversations are the signed-in caller's own
                  "Sign in to chat: " + message
                : message,
        );
        options.onError?.(error);
    }

    function busy(state: boolean): void {
        sending = state;
        button.disabled = state;
        root.setAttribute("data-vb-state", state ? "sending" : "idle");
    }

    // --- the conversation ---

    function open(): Promise<ServerConversation | null> {
        if (!opening) {
            const conversations = client.ai.conversations;
            const wanted = options.conversation
                ? conversations.open(options.conversation)
                : conversations.start({
                      system: options.system,
                      model: options.model,
                      tools: options.tools,
                  });

            opening = wanted.then(
                (opened) => {
                    if (gone) {
                        return null;
                    }
                    conversation = opened;
                    if (options.realtime !== false) {
                        unsubscribe = opened.subscribe(() => paint());
                    }
                    paint();
                    return opened;
                },
                (err) => {
                    opening = null; // a later turn may try again
                    if (!gone) {
                        refused(err);
                    }
                    return null;
                },
            );
        }

        return opening;
    }

    /**
     * Puts back into the box what a refused turn was going to say, unless
     * something has been typed since.
     */
    function keep(content: string): void {
        if (!input.value) {
            input.value = content;
        }
    }

    async function send(text: string): Promise<void> {
        const content = (text || "").trim();
        if (!content || sending || gone) {
            return;
        }

        busy(true);

        // the turn shows at once, the answer filling in as it arrives
        const reply = line("assistant", "");
        live = {
            user: line("user", content),
            reply,
            body: reply.querySelector("." + prefix + "-content") as HTMLElement,
        };
        paint();

        const chat = await open();
        if (!chat || gone) {
            live = null;
            if (!gone) {
                paint();
                keep(content);
            }
            busy(false);
            return;
        }

        pending =
            typeof AbortController !== "undefined" ? new AbortController() : null;
        const signal: any = pending ? pending.signal : undefined;

        try {
            if (streaming) {
                await chat.stream(content, {
                    signal,
                    onDelta: (delta) => {
                        if (live) {
                            live.body.textContent =
                                (live.body.textContent || "") + delta;
                            list.scrollTop = list.scrollHeight;
                        }
                    },
                });
            } else {
                await chat.send(content, { signal });
            }
            live = null;
            paint();
        } catch (err) {
            live = null;
            if (!gone) {
                paint();
                keep(content); // nothing typed is lost to a refusal
                refused(err);
            }
        } finally {
            pending = null;
            busy(false);
        }
    }

    // --- the events ---

    const onSubmit = (e: Event) => {
        e.preventDefault();
        const text = input.value;
        input.value = "";
        send(text);
    };

    const onKeydown = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit(e);
        }
    };

    form.addEventListener("submit", onSubmit);
    input.addEventListener("keydown", onKeydown);

    paint();
    open();

    return {
        get element() {
            return root;
        },
        get conversation() {
            return conversation;
        },
        send,
        destroy() {
            if (gone) {
                return;
            }
            gone = true;
            form.removeEventListener("submit", onSubmit);
            input.removeEventListener("keydown", onKeydown);
            unsubscribe?.();
            unsubscribe = null;
            pending?.abort();
            pending = null;
            root.remove();
        },
    };
}
