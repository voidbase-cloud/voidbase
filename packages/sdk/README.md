voidbase JavaScript SDK
======================================================================

The [PocketBase JavaScript SDK](https://github.com/pocketbase/js-sdk), kept in step with upstream, plus what a [voidbase](https://voidbase.cloud) instance can use on top of it: a typed client, a plugin surface, an offline queue, PWA helpers and in-place editing.

This package is a fork of `pocketbase` (the PocketBase JS SDK, MIT, by Gani Georgiev and contributors; this release tracks upstream 0.28.1). Everything the upstream package does, this one does the same way and against the same wire protocol, so it works against any PocketBase server and any voidbase instance. The additions live beside the upstream code, not inside it, so upstream releases merge in cleanly.

- [Installation](#installation)
- [What is added](#what-is-added)
- [PocketBase JavaScript SDK documentation](#pocketbase-javascript-sdk-documentation)
- [Development](#development)


## Installation

```sh
bun add @voidbase-cloud/sdk
# or: npm install @voidbase-cloud/sdk --save
```

```js
import PocketBase from "@voidbase-cloud/sdk";

const pb = new PocketBase("https://example.com");
```

`import PocketBase from "@voidbase-cloud/sdk"` is a drop-in for `import PocketBase from "pocketbase"`: the default export is the same `Client` class, and every named export of the upstream package (`ClientResponseError`, `RecordService`, `LocalAuthStore`, the DTO types and so on) is exported under the same name. The CommonJS and UMD bundles are at `@voidbase-cloud/sdk/cjs` and `@voidbase-cloud/sdk/umd`, as `pocketbase/cjs` and `pocketbase/umd` are upstream.


## What is added

Nine things, each beside the upstream code rather than inside it:

1. [Typed collections](#typed-collections): `VoidBase<Collections>`, a client whose `collection()` is narrowed to the file `voidbase types` writes.
2. [A plugin surface](#plugins-and-hook-lists): `client.use(plugin)`, and hook lists on the request path.
3. [An offline queue](#offline-queue): `offline()` from `@voidbase-cloud/sdk/offline`, as a plugin on that surface.
4. [PWA helpers](#pwa-helpers): `registerServiceWorker()`, `installPrompt()` and the `pwa()` plugin from `@voidbase-cloud/sdk/pwa`, for the service worker the voidbase adapter serves.
5. [In-place editing](#in-place-editing): `editable()` from `@voidbase-cloud/sdk/editable`, a plugin that makes marked elements editable for signed-in users and saves what they type.
6. [A chat helper](#chat-helper): `ai()` from `@voidbase-cloud/sdk/ai`, a plugin over the instance's Workers AI chat route, and `mountChat()` for a chat widget on the page.
7. [A payments helper](#payments-helper): `payments()` from `@voidbase-cloud/sdk/payments`, a plugin over the instance's checkout, portal and cancel routes and the rows they write.
8. [An SEO helper](#seo-helper): `seo()` from `@voidbase-cloud/sdk/seo`, a plugin that fetches a page's tags from the instance and writes them into the head, and `seoHead()` for server rendering.
9. [Interface strings](#interface-strings): `i18n()` from `@voidbase-cloud/sdk/i18n`, the runtime for the catalogues `voidbase i18n extract` writes, with `t` typed from the generated keys.

### Typed collections

`VoidBase` is the `Client` with `collection(name)` typed per collection. It takes a map of collection names to record types; a name the map knows answers a `RecordService` of that record, any other name answers an untyped `RecordService<RecordModel>` as the plain client does, so system collections such as `_superusers` keep working. Everything else on the class is the `Client`, unchanged.

The map is the `Collections` interface that `voidbase types` writes from a voidbase instance's own OpenAPI document:

```sh
voidbase types --url https://<instance> --token <superuser token> --out src/voidbase.ts
```

```ts
import { VoidBase } from "@voidbase-cloud/sdk";
import type { Collections } from "./voidbase";

const pb = new VoidBase<Collections>("https://<instance>");

const post = await pb.collection("posts").getOne("RECORD_ID"); // PostsRecord
post.title;                                                      // string
post.titel;                                                      // compile error
post.expand?.author;                                             // UsersRecord | undefined, when the relation is typed

const page = await pb.collection("users").getList(1, 20);        // ListResult<UsersRecord>

pb.collection("_superusers");                                    // RecordService<RecordModel>, not in the map
```

Regenerate the file when the collections change and a renamed field becomes a compile error at the call. Without a type argument (`new VoidBase(url)`) every name is untyped, which is the plain client's behaviour.

The exported types are `CollectionMap` (`Record<string, RecordModel>`, what a map looks like), `AnyCollections` (the default, every name untyped) and `CollectionMapOf<C>` (the constraint, written as a mapped type so that an interface without an index signature, which is what the generator writes, satisfies it). You can write the map by hand too; any interface whose values extend `RecordModel` fits.

### Plugins and hook lists

A plugin is an object with a name and an `install(client)` function; what `install` returns, if a function, is the uninstall. It goes on any client, `Client` or `VoidBase`:

```ts
import PocketBase, { type Plugin } from "@voidbase-cloud/sdk";

const tracing: Plugin = {
    name: "tracing",
    install(client) {
        const remove = client.hooks.beforeSend.add((url, options) => {
            options.headers = Object.assign({}, options.headers, { "X-Trace": crypto.randomUUID() });
        });
        return remove; // called by client.unuse("tracing")
    },
};

const pb = new PocketBase("https://<instance>").use(tracing);

pb.plugins;          // ["tracing"]
pb.unuse("tracing"); // uninstalls; unknown names are ignored
```

`use` installs once per name (a second `use` of the same name throws) and returns the client. A plugin can say what it attaches, `Plugin<{ offline: OfflineQueue }>`, and then `client.use(plugin)` answers the client with that addition typed, which is how `pb.offline` below gets its type.

What a plugin sits in is the hook lists, on the request path of every `client.send()`:

- `client.hooks.beforeSend.add(fn)`: `fn(url, options)` right before the fetch request; modify `options` in place or return `{ url, options }` to replace them.
- `client.hooks.afterSend.add(fn)`: `fn(response, data, options)` after the reply is parsed; what it returns (a value or a promise) becomes the data for the next hook and, after the last, for the caller.
- `client.hooks.onError.add(fn)`: `fn(err, { url, options })` with the `ClientResponseError` about to be thrown (a network failure has `status` 0 and the thrown error as `originalError`; an error reply has its status and data). Return `undefined` to pass the error on, a `Response` (anything with `json()` and a numeric `status`) to have it parsed as the reply instead, or any other value to resolve the request with it as the data.

Every `add` returns a function that removes what it added; the lists also have `remove(fn)`, `clear()`, `size` and `list()`. Hooks run in the order they were added, and each list runs after the corresponding upstream property: `client.beforeSend` and `client.afterSend` keep working exactly as [documented below](#send-hooks) and run first.

```ts
// retry once on a network failure, from a hook
pb.hooks.onError.add(async (err, { url, options }) => {
    if (err.status !== 0 || err.isAbort) return;
    return fetch(url, options); // the Response is parsed as the original one would have been
});
```

### Offline queue

Writes that survive a tunnel. `offline()` is a plugin, from its own entry point so that an application that does not want it does not carry it:

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { offline } from "@voidbase-cloud/sdk/offline";

const pb = new PocketBase("https://<instance>").use(offline());

// with the network gone, this answers at once
const post = await pb.collection("posts").create({ title: "written in a tunnel" });
post.id; // a 15-character id chosen by the client; the replay creates this record

pb.offline.pending();
// [{ collection: "posts", op: "create", id: "...", body: { title: "...", id: "..." }, at: 1757... }]

pb.offline.on("queued", (mutation) => ...);
pb.offline.on("flushed", ({ replayed, remaining }) => ...);
pb.offline.on("failed", ({ mutation, error }) => ...); // the server refused a replay with a 4xx

await pb.offline.flush(); // or wait for the window "online" event
```

Installed, the plugin wraps `create`, `update` and `delete` of every `RecordService` the client hands out from then on (install it before taking services from the client). A mutation is queued when the request fails with a network error (fetch throws) or, without a request, when `navigator.onLine` is `false`, and the caller is answered optimistically:

- `create` answers the body with the chosen `id` (and `collectionName`). The id is chosen up front for every create while the plugin is installed, whether or not it ends up queued, and sent as `id` in the body, which PocketBase accepts; that is what makes a replay create the record the caller was told about, and a create whose reply was lost not be created twice. For a collection whose id field has other rules, pass `newId: (collection) => string`.
- `update` answers the body merged over the id.
- `delete` answers `true`.

A body that is a `FormData` (a file upload) is not queued; the request is sent as it is and its failure is thrown. A reply the server refused (a 4xx while online) is thrown, not queued.

The queue is replayed in order, oldest first, on the window `online` event, on `client.offline.flush()`, and at install when the store holds a queue from an earlier session and the network is up. A replay goes through the client's normal request path (the hooks run) with `requestKey: null` so it is never auto-cancelled. During a replay, a network failure stops the run and keeps that mutation and the rest for the next one; a 4xx drops the mutation and reports it through the `failed` event (the server will not accept it later either: a validation error, a rule, a record already gone); a 5xx stops the run as a network failure does.

The queue is persisted in a store: `localStorage` under the `key` option (default `voidbase_offline_queue`) when it exists, memory otherwise, or anything with `get(): string | null` and `set(value: string)`, sync or async, passed as `store`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

offline({
    store: {
        get: () => AsyncStorage.getItem("queue"),
        set: (value) => AsyncStorage.setItem("queue", value),
    },
});
```

`client.offline.ready` resolves once the store has been read; `client.offline.clear()` drops the queue without replaying it. The other options are `isOnline: () => boolean` (default `navigator.onLine !== false`), `isNetworkError: (err) => boolean` (default: a `ClientResponseError` with status 0 that is not an abort) and `listen: false` to not subscribe to the `online` event. `client.unuse("offline")` restores the services and removes `client.offline`.

#### Reads from the store

With the `cache` option the same plugin also reads through a local store, so a screen renders before the network answers:

```ts
const pb = new PocketBase("https://<instance>").use(
    offline({
        cache: {
            collections: ["posts", "comments"], // nothing else is cached
            mode: "stale-while-revalidate",     // the default
            max: 500,                           // records kept per collection (the default)
        },
    }),
);

// the store answers at once when it has the page, the request follows in the background
const list = await pb.collection("posts").getList(1, 20);
list.fromCache;              // true when the store answered
list.items[0].__fromCache;   // and on each of its records

// the reply landed differently: render again
pb.offline.on("cache", ({ collection, kind, key }) => refresh(collection));

pb.offline.cache.get("posts", id); // the cached copy, or undefined
pb.offline.cache.size();           // how many records are kept
await pb.offline.cache.clear("posts");
await pb.offline.cache.clear();
```

`getOne(id)` and `getList(page, perPage, options)` of a named collection are written through to the store: each record by its id, and each page under the key of its query (the page, its size, the filter, the sort, the fields, the expand), so the same call reads back what it wrote and a different filter does not. When a request fails for a network reason (the test the queue already uses: fetch throws, or `navigator.onLine` is `false`) the store answers instead, and what it answers carries a marker: `record.__fromCache === true`, `result.fromCache === true` for a list. When the store has nothing either, the original error is thrown. The types are `CachedRecord<T>` and `CachedListResult<T>`, for a call that wants them typed: `getOne<CachedRecord<Post>>(id)`.

In `stale-while-revalidate`, the default, a cached answer is returned at once and the request is made in the background; when it lands differently the client emits `cache` with `{ collection, kind: "one" | "list", key }`. In `offline-only` the store is read only after a request failed.

The store is kept fresh without the application doing anything: realtime `create`, `update` and `delete` of a cached collection are applied to it (subscribe as usual, with `client.collection(c).subscribe(...)`, and your own subscriber still runs), and a mutation the queue answered optimistically lands in it too, so a queued create shows up at the front of the next cached list and is replaced by the real record when the replay lands.

It is a cache for rendering, not a local database: it holds only what has been read, a cached list can be stale (and can miss a record dropped by `max`), it is not queried or filtered, and `max` (500 by default) drops the least recently written records of a collection first. It keeps its own store: the queue's default choice (localStorage, else memory) under its own key (`voidbase_offline_cache`, or the queue's `key` with `_cache` appended), or anything passed as `cache.store`.


### PWA helpers

The voidbase adapter's `pwa` option serves a `manifest.webmanifest` and a `sw.js` at the site root. `@voidbase-cloud/sdk/pwa` is the page side of that worker: it registers it, tells the app when a new version is ready, and speaks the worker's message protocol (the worker never skips waiting on its own; the page posts `SKIP_WAITING` to the waiting worker; the new worker posts `UPDATED` with its version once it has taken over; `UNREGISTER` makes it unregister itself and clear its caches).

```ts
import { registerServiceWorker } from "@voidbase-cloud/sdk/pwa";

const sw = await registerServiceWorker({
    onUpdate: (apply) => {
        // a new version is installed and waiting; apply() posts SKIP_WAITING
        // and reloads the page once the new worker controls it
        if (confirm("A new version is ready. Reload?")) apply();
    },
    onUpdated: (version) => console.log("running", version),
});

sw?.version;            // the version the worker last reported, null until it does
await sw?.update();     // check for a new script now
await sw?.unregister(); // posts UNREGISTER (the worker clears its caches), then unregisters
```

The registration happens after the window `load` event (at once when the document is already loaded), from `/sw.js` unless `url` (and `scope`) say otherwise. It answers `null`, without throwing, where there is no `window` (server-side rendering) or no `navigator.serviceWorker`. A worker that installs while an older one controls the page is an update: with `immediate: true` it is applied at once, with `onUpdate` the app decides, and with neither the new worker waits until every tab of the site is closed, as browsers do by default. The first install of the site is never reported as an update and never reloads.

The install prompt of the page is captured from the browser's `beforeinstallprompt` event, so that the app can show it from its own button. Call `installPrompt()` early, at module load, so the event is not missed:

```ts
import { installPrompt } from "@voidbase-cloud/sdk/pwa";

const install = installPrompt();
install.onAvailable(() => (button.hidden = false));
button.onclick = async () => {
    const outcome = await install.prompt(); // "accepted" | "dismissed" | "unavailable"
};
```

As a plugin, `pwa(options)` runs `registerServiceWorker(options)` at install and attaches the pending registration as `client.pwa`:

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { pwa } from "@voidbase-cloud/sdk/pwa";

const pb = new PocketBase("https://<instance>").use(pwa({ immediate: true }));

const sw = await pb.pwa; // PwaRegistration, or null where unsupported
```

`client.unuse("pwa")` removes `client.pwa`; it does not unregister the worker.


### In-place editing

Rendered text that signed-in users can edit where it stands. `editable()` is a plugin from its own entry point; it touches only elements marked with `data-vb-edit="collection:id:field"`:

```html
<h1 data-vb-edit="posts:RECORD_ID:title">Hello</h1>
<p data-vb-edit="posts:RECORD_ID:body" data-vb-edit-multiline>...</p>
```

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { editable } from "@voidbase-cloud/sdk/editable";

const pb = new PocketBase("https://<instance>").use(
    editable({
        canEdit: ({ collection, id }, field) => field !== "slug",
        onSaved: ({ collection, id, field }, value, record) => ...,
        onError: ({ collection, id, field }, value, error) => ...,
    }),
);
```

While `pb.authStore` holds a valid token (the plugin watches `authStore.onChange`), every marked element is `contenteditable`; when the token goes, it is not. Elements added later are picked up by a `MutationObserver`, and a changed mark is followed. What is typed is saved through `pb.collection(collection).update(id, { [field]: text })` after a pause in typing (`debounce`, default 400 ms), on blur, and on Enter (a `data-vb-edit-multiline` element lets Enter insert a line and saves on blur). Around a save the element carries `data-vb-state="saving"`, then `"saved"` or `"error"`, cleared after `idleTimeout` (default 1500 ms), for the page to style:

```css
[data-vb-state="saving"] { opacity: 0.6; }
[data-vb-state="error"] { outline: 2px solid crimson; }
```

Escape reverts to the last saved text without saving; a save the server refuses reverts as well and calls `onError`. `canEdit(record, field)` vetoes per element (the record here is `{ collection, id }`, what the mark says). The text saved is the element's `textContent`. Where there is no `document` (server-side) the plugin installs and does nothing.

Before an element gets its affordance the instance is asked whether this caller may write the field. `GET /api/collections/<collection>/records/<id>/can-update` (voidbase 0.9.0-beta.38 and up) answers `{ allowed, fields, reason }` for the token in `pb.authStore`, and an element whose record is refused, or whose field is not in `fields`, is left as it is. Each record is asked about once and the answer kept for the session (dropped when the token changes), so two elements of the same record cost one request, and an element `canEdit` vetoes costs none. An element therefore becomes editable a round trip after the scan rather than in the same breath as it. An instance without the route answers 404 or 405, as it does for a record the caller may not see; the element is then enabled as it was before the route existed, and a refused save reverts it as ever. `canEdit` still vetoes on top: the route saying yes never overrides it.

With `realtime: true` the plugin subscribes to the touched records, one subscription per collection filtered to its ids and replaced as the set of ids changes, so that an edit made in another tab lands in the element (not while it is focused or a save of it is in flight).

`client.editable.enabled` says whether elements are editable right now, `client.editable.refresh()` scans the root again, `client.editable.flush()` saves every element with unsaved text. The other options are `attribute` (the mark's name, default `data-vb-edit`; the multiline mark is that name plus `-multiline`) and `root` (where to look, default `document`). `client.unuse("editable")` removes `contenteditable` and the state marker from every element, disconnects the observer and the realtime subscriptions, and removes `client.editable`.

#### Markdown

An element that shows rendered markdown is marked `data-vb-edit-markdown` as well; it then edits the field's markdown source rather than its rendered text:

```html
<article data-vb-edit="posts:RECORD_ID:content" data-vb-edit-markdown>
    <p>The <strong>rendered</strong> content</p>
</article>
```

```ts
import { marked } from "marked";

const pb = new PocketBase("https://<instance>").use(
    editable({
        render: (markdown) => marked.parse(markdown) as string,
        saveOnBlur: true, // the default; false leaves the editor open until Save
        preview: true,    // the default; "toggle" for a button, false for neither
    }),
);
```

Such an element is not `contenteditable`; it is focusable, and on focus or click it is swapped in place for an editing surface: a `<textarea>` sized to the element holding the source, fetched once from the record (`getOne(id, { fields: field })`) and kept per element, with a small toolbar above it (bold, italic, heading, link, bulleted list, code, Save, Cancel) that applies markdown syntax around the selection or toggles it off again. Ctrl/Cmd+B, I and K do bold, italic and link; Escape cancels. Save, or blur while `saveOnBlur` is true, writes the source through the same `update(id, { [field]: source })` with the same `data-vb-state` states, `onSaved` and `onError` as the text mode; a refused save keeps the element as it was. After a save the element shows the new source through `render` when you pass one (no markdown renderer is bundled; pass `marked.parse` or similar, sanitized as your app requires) and as plain text otherwise. The surface has the classes `vb-editable-markdown` (the wrapper) and `vb-editable-toolbar`, each button a `data-vb-action`, and only the inline styles needed to sit in place, so the app can restyle it.

With a `render` the editor also shows what it makes of the source beside the textarea, in a container that wraps (`vb-editable-panes`), so the preview sits under the source on a narrow element. It is refreshed as you type and as the toolbar writes, after the same pause as a save (`debounce`). `preview: "toggle"` puts a Preview button in the toolbar instead and starts with the pane hidden, the button carrying `aria-pressed`; `preview: false` leaves both out. Without a `render` there is no preview and no button whatever the option says, since the preview is only ever what `render` returns, into `vb-editable-preview`.


### Chat helper

`@voidbase-cloud/sdk/ai` talks to the instance's `POST /api/ai/chat` route, which answers with Workers AI (and the instance's tools, when it allows them). `ai()` is a plugin; `chat` goes through `client.send`, so the auth token and the hook lists apply:

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { ai } from "@voidbase-cloud/sdk/ai";

const pb = new PocketBase("https://<instance>").use(ai({ persist: true }));

const { message, steps, model } = await pb.ai.chat(
    [
        { role: "system", content: "Answer in one sentence." },
        { role: "user", content: "How many posts were published this week?" },
    ],
    { tools: true, maxSteps: 3 },
);
message.content; // the assistant's answer
steps;           // [{ tool, arguments, result }] for each tool call the model made
```

`chat(messages, options)` posts `{ messages, model?, tools?, maxSteps? }` and answers `{ message: { role: "assistant", content }, steps, model }`; `options.signal` aborts it, and `model`, `tools` and `maxSteps` given to `ai()` are the defaults for every chat. Each chat is its own request (no auto-cancellation between two). When the instance has no Workers AI binding the route answers 503, which is thrown as a `ClientResponseError` like any other refused request (`err.status`, `err.response.message`).

`conversation()` keeps a history and sends it whole with every turn:

```ts
const chat = pb.ai.conversation({ system: "You help with the docs." });

const reply = await chat.send("What is a hook list?");
chat.messages; // the system message, the user's turn and the assistant's answer
await chat.send("And how do I remove one?"); // the whole history goes along
chat.reset();  // back to the system message
```

A refused turn leaves the history as it was. With `persist: true` on `ai()` every conversation is kept in `sessionStorage`, under `conversation({ key })` or the `key` option of `ai()` (default `vb_ai_conversation`), and a conversation created with the same key on a later page starts from what was kept; `reset()` removes it. Types `AiMessage`, `AiReply`, `AiStep`, `AiChatOptions`, `AiConversation`.

#### Conversations on the server

From voidbase 0.9.0-beta.32 the instance keeps conversations as records for signed-in users (`/api/ai/conversations`, the collections `ai_conversations` and `ai_messages`), so a chat survives the tab and can be picked up on another device. `pb.ai.conversations` is that route; `create`, `list`, `get` and `remove` go through `client.send`, and `open(id)` or `start(options)` answer a `ServerConversation` that sends one turn at a time, the history living on the server:

```ts
const kept = await pb.ai.conversations.start({ title: "Support", system: "You help with the docs." });

const reply = await kept.send("What is a hook list?", { maxSteps: 3 });
kept.messages; // the user's turn and the assistant's answer

// the same answer, as it streams in
await kept.stream("And how do I remove one?", {
    onDelta: (chunk) => output.append(chunk),
});

// a reply landing from another tab reaches kept.messages
const stop = kept.subscribe((message, action) => render(kept.messages));
stop();

// later, on another page
const { items } = await pb.ai.conversations.list({ page: 1, perPage: 20 });
const again = await pb.ai.conversations.open(items[0].id);
again.messages; // oldest first, with id, steps, tokens and created
await again.refresh();
await again.remove();
```

`create({ title, model, system, tools })` posts those and answers the record; `list({ page, perPage })` answers `{ page, perPage, totalItems, totalPages, items }`; `get(id)` answers the record with its `messages`, oldest first; `remove(id)` deletes it. On a `ServerConversation`, `send(content, { maxSteps, signal })` posts to `/api/ai/conversations/<id>/messages` and answers `{ message, steps, model, conversation }`, appending both turns to `messages` (a refused turn leaves them as they were). `stream(content, { maxSteps, signal, onDelta })` posts the same with `stream: true` and reads the `text/event-stream` answer with `fetch` (the client's URL and token, but not the hook lists), calling `onDelta` with each chunk and resolving with the done event; an `error` event mid-stream rejects with its message, and a refused request rejects with an error carrying `status` and `response`. `subscribe(callback)` follows `ai_messages` over realtime with the filter `conversation = "<id>"`: a created message is merged into `messages` (replacing the local echo of a turn sent here), an updated one replaced, a deleted one removed, and the callback gets the record and the action; the returned function unsubscribes. `refresh()` fetches the record and messages again, `record` is the conversation as last answered, and `remove()` deletes it. Anonymous callers get a 401 from every route. Types `AiConversationRecord`, `AiMessageRecord`, `AiConversationDetail`, `AiConversationsList`, `AiServerReply`, `ServerConversation`, `AiConversations`.


#### A chat widget

`mountChat(target, options)` builds a small chat in an element over `pb.ai.conversations`, with no framework and no styles beyond what it takes to sit in the page:

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { ai, mountChat } from "@voidbase-cloud/sdk/ai";

const pb = new PocketBase("https://<instance>").use(ai());

const chat = mountChat("#chat", {
    client: pb,
    system: "You help with the docs.",
    greeting: "Ask me about the docs.",
    placeholder: "Ask a question",
});

await chat.send("What is a hook list?"); // what the Send button does
chat.conversation;                       // the ServerConversation, once it is open
chat.destroy();                          // out of the page, and unsubscribed
```

The target is an element or a selector for one. The widget mounts a container with a message list, a textarea and a Send button (Enter sends, Shift+Enter is a newline) and opens its conversation as it mounts: `conversation: "<id>"` opens that one and shows its messages, otherwise one is started with `system`, `model` and `tools`. Every part carries a class for the application to style, the inline styles being structural only: `vb-chat`, `-messages`, `-message` with `-user` or `-assistant` and a `data-vb-role`, `-content`, `-steps`, `-step`, `-notice`, `-form`, `-input` and `-send`, where `classPrefix` replaces the `vb-chat` part.

A turn appears in the thread as it is sent and the answer fills in as it streams, `stream: false` waiting for the whole answer instead. The tool calls behind an answer are a line one can open ("used posts_list") rather than nothing at all. With `realtime` left on, the conversation is followed over realtime, so a reply from another tab appears here too. What the model answers is set as text, never as HTML. A refused turn is a line in the thread and leaves what it was going to say in the box: an anonymous caller, whom the instance answers 401, is told to sign in rather than getting a throw, and `onError` is called with the error. Types `ChatMountOptions`, `ChatMount`.


### Payments helper

`@voidbase-cloud/sdk/payments` talks to the instance's `POST /api/payments/<provider>/checkout`, `/portal` and `/cancel` routes, provided by whichever payments plugin the instance loaded (Stripe, Polar or Lemon Squeezy). `payments()` is a plugin; every call goes through `client.send`, so the auth token and the hook lists apply, and the routes act for the signed-in user:

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { payments } from "@voidbase-cloud/sdk/payments";

const pb = new PocketBase("https://<instance>").use(payments({ provider: "stripe" }));

// sends the user to the provider's checkout page
await pb.payments.redirectToCheckout([{ price: "price_123", quantity: 1 }], {
    success: location.origin + "/thanks",
    cancel: location.href,
    mode: "subscription",
});

// the provider's billing portal, and cancelling without it
await pb.payments.redirectToPortal({ return: location.href });
const { status, cancelAtPeriodEnd } = await pb.payments.cancel("SUBSCRIPTION_ROW_ID", { now: false });

// what the webhooks wrote for this user
const { customer, subscriptions, payments: paid } = await pb.payments.mine();
```

`checkout(items, { success, cancel, mode? })` posts the items (`{ price, quantity }`, quantity 1 when omitted) and the URLs and answers `{ url }`; `portal({ return })` and `cancel(subscription, { now? })` likewise, the last answering `{ subscription, status, cancelAtPeriodEnd }`. `redirectToCheckout` and `redirectToPortal` call those and set `location.href` in a browser; on the server they only answer the URL. `mine()` lists the `customers`, `subscriptions` and `payments` collections with `getFullList` (their rules scope them to the signed-in user) and answers `{ customer, subscriptions, payments }`, `customer` being `null` before the first checkout; it takes type parameters for the three records.

Which provider the instance routes payments to comes from `GET /api/plugins` (its `payments` field, `{ via, webhook, livemode }`), read once per client and cached; `provider()` answers it. That route is a superuser's today, so a client signed in as a regular user gets a 401 or 403 there and the plugin falls back to the `provider` option; without one it throws an error saying to pass it. An instance with no payments plugin answers `via: "none"`, and `checkout`, `portal` and `cancel` throw before any request. A refused route (a signed-out client, an unknown subscription) is thrown as the usual `ClientResponseError`. Types `PaymentsProvider`, `PaymentsRoute`, `PaymentsItem`, `PaymentsCheckoutOptions`, `PaymentsCancelReply`, `PaymentsMine`.


### SEO helper

`@voidbase-cloud/sdk/seo` talks to the instance's `GET /api/seo/meta` route, which answers the tags of a page (a path of the site, or a record) from the collections and the `VOIDBASE_SEO` mapping. `seo()` is a plugin; `meta` goes through `client.send`, so the hook lists apply, and `apply` writes the answer into the document:

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { seo } from "@voidbase-cloud/sdk/seo";

const pb = new PocketBase("https://<instance>").use(seo());

// on every navigation of a single-page app
const meta = await pb.seo.meta({ collection: "posts", id: post.id }); // or { path: location.pathname }
pb.seo.apply(meta);

pb.seo.shareImage("posts", post.id);        // https://<instance>/api/seo/og/posts/RECORD_ID.svg
pb.seo.shareImage("posts", post.id, "png"); // the same as a PNG
```

`meta(target)` answers `{ canonical, title, description, image, type, locale, alternates, jsonld, og, twitter, html }`; a newer call cancels an older one still in flight (the client's auto-cancellation), unless it brings its own `signal`. An unknown page is thrown as the usual `ClientResponseError`.

`apply(meta, doc = document)` sets `document.title` and writes the canonical link, the description, one `<link rel="alternate" hreflang>` per alternate, the `og:` and `twitter:` metas and the JSON-LD script into the head. It is idempotent: everything it writes is marked `data-vb-seo` and removed at the next apply, and an element the page already had for the same tag (a server-rendered canonical, say) is updated rather than doubled, so applying on every navigation leaves one set of tags. The `og` and `twitter` maps take keys with or without their prefix, and an array value is one tag per value (`og:locale:alternate`). Without a `document` (on the server) `apply` does nothing.

For a server-rendered page, `seoHead(meta)` is the same set of tags as an HTML fragment: the `html` the route sent when there is one, else built from the fields, with attribute values escaped and the JSON-LD kept from closing its script:

```ts
import { seoHead } from "@voidbase-cloud/sdk/seo";

const meta = await pb.seo.meta({ path: url.pathname });
const page = `<!doctype html><html><head>${seoHead(meta)}</head><body>...</body></html>`;
```

Types `SeoMeta`, `SeoTarget`, `SeoImageFormat`, `SeoController`.


### Interface strings

`voidbase i18n extract` (voidbase 0.9.0-beta.38 and up) reads the `t("key", "Default text")` calls in the source and writes two things per project: `i18n/<locale>.json`, a flat key-to-text object sorted by key where `""` is an untranslated string, and `i18n/keys.d.ts`, the `MessageKey`, `Locale` and `Messages` types. It writes no runtime on purpose. This is the runtime:

```sh
voidbase i18n extract
# i18n/en.json, i18n/ar.json, i18n/keys.d.ts
```

```ts
import PocketBase from "@voidbase-cloud/sdk";
import { i18n } from "@voidbase-cloud/sdk/i18n";
import type { MessageKey } from "./i18n/keys";
import en from "./i18n/en.json";
import ar from "./i18n/ar.json";

const pb = new PocketBase("https://<instance>").use(
    i18n<MessageKey>({ catalogues: { en, ar }, persist: true }),
);

pb.i18n.t("greeting");               // "Hello"
pb.i18n.t("hello", { name: "Ada" }); // "Hello, Ada"
pb.i18n.t("farewell");               // compile error: nothing calls that key any more

pb.i18n.onChange(() => render());
pb.i18n.setLocale("ar");             // and everything asks for its text again
```

The type argument is the `MessageKey` of the generated `i18n/keys.d.ts`, and `client.use()` carries it through to `pb.i18n.t`, so a key that is still in the catalogue but no longer called anywhere is a compile error at the call rather than an empty string at runtime. Without the argument any string is a key. The catalogues are passed in rather than read from disk, because this runs in a browser; they are exactly what the JSON files export.

The locale in use is the `locale` option when there is one (matched against the catalogue names, exactly and then by primary subtag, so `"en-GB"` finds `"en"`, and kept as given when nothing matches). Without it the plugin negotiates: the persisted choice, then `navigator.language` and `navigator.languages`, then the first catalogue, which is the source locale. `setLocale(code)` matches the same way, calls the `onChange` listeners (each `onChange` answers the function that stops it) and, with `persist`, remembers the code in `localStorage` under `voidbase_locale` or under the key the option names.

`t(key, vars)` answers the text of the locale in use, with `{name}` placeholders filled from `vars` (a placeholder without a value is left alone, and `vars: { open: "[[", close: "]]" }` changes the delimiters). An empty string, which is what the extractor writes for a key nobody has translated yet, falls through to the source locale's text and then to the key itself; `fallback: "key"` answers the key straight away instead. A key that ends up answering itself is recorded for `missing()` and passed to the `onMissing` option, which is how an untranslated screen shows up in a test run. `has(key)` is whether the key answers a text rather than itself.

The locale travels: every request the client sends carries `Accept-Language: <locale>`, added by one `beforeSend` hook, so the `translations` plugin on the instance answers record content in the same language the interface is in. That is what ties the two halves together, and `header: false` turns it off and leaves the client's own `lang` alone. `client.unuse("i18n")` removes `client.i18n` and the hook.

Types `Catalogue`, `Catalogues`, `I18nVars`, `Translate`, `I18nDelimiters`, `I18nOptions`, `I18nController`, `I18nClient`.


## PocketBase JavaScript SDK documentation

Everything below this heading is PocketBase's own documentation for the SDK, kept as upstream wrote it (with `pocketbase` as the package name in the examples; substitute `@voidbase-cloud/sdk`). The upstream original is at [pocketbase/js-sdk](https://github.com/pocketbase/js-sdk).

---

Official JavaScript SDK (browser and node) for interacting with the [PocketBase API](https://pocketbase.io/docs).

- [Installation](#installation)
- [Usage](#usage)
- [Caveats](#caveats)
    - [Binding filter parameters](#binding-filter-parameters)
    - [File upload](#file-upload)
    - [Error handling](#error-handling)
    - [Auth store](#auth-store)
        - [LocalAuthStore (default)](#localauthstore-default)
        - [AsyncAuthStore (_usually used with React Native_)](#asyncauthstore)
        - [Custom auth store](#custom-auth-store)
        - [Common auth store fields and methods](#common-auth-store-fields-and-methods)
    - [Auto cancellation](#auto-cancellation)
    - [Specify TypeScript definitions](#specify-typescript-definitions)
    - [Custom request options](#custom-request-options)
    - [Send hooks](#send-hooks)
    - [SSR integration](#ssr-integration)
    - [Security](#security)
- [Definitions](#definitions)
- [Development](#development)


## Installation

### Browser (manually via script tag)

```html
<script src="/path/to/dist/pocketbase.umd.js"></script>
<script type="text/javascript">
    const pb = new PocketBase("https://example.com")
    ...
</script>
```

_OR if you are using ES modules:_
```html
<script type="module">
    import PocketBase from '/path/to/dist/pocketbase.es.mjs'

    const pb = new PocketBase("https://example.com")
    ...
</script>
```

### Node.js (via npm)

```sh
npm install pocketbase --save
```

```js
// Using ES modules (default)
import PocketBase from 'pocketbase'

// OR if you are using CommonJS modules
const PocketBase = require('pocketbase/cjs')
```

> 🔧 For **Node < 17** you'll need to load a `fetch()` polyfill.
> I recommend [lquixada/cross-fetch](https://github.com/lquixada/cross-fetch):
> ```js
> // npm install cross-fetch --save
> import 'cross-fetch/polyfill';
> ```
---
> 🔧 Node doesn't have native `EventSource` implementation, so in order to use the realtime subscriptions you'll need to load a `EventSource` polyfill.
> ```js
> // for server: npm install eventsource --save
> import { EventSource } from "eventsource";
>
> // for React Native: npm install react-native-sse --save
> import EventSource from "react-native-sse";
>
> global.EventSource = EventSource;
> ```


## Usage

```js
import PocketBase from 'pocketbase';

const pb = new PocketBase('http://127.0.0.1:8090');

...

// authenticate as auth collection record
const userData = await pb.collection('users').authWithPassword('test@example.com', '123456');

// list and filter "example" collection records
const result = await pb.collection('example').getList(1, 20, {
    filter: 'status = true && created > "2022-08-01 10:00:00"'
});

// and much more...
```
> More detailed API docs and copy-paste examples could be found in the [API documentation for each service](https://pocketbase.io/docs/api-records/).


## Caveats

### Binding filter parameters

The SDK comes with a helper `pb.filter(expr, params)` method to generate a filter string with placeholder parameters (`{:paramName}`) populated from an object.

**This method is also recommended when using the SDK in Node/Deno/Bun server-side list queries and accepting untrusted user input as `filter` string arguments, because it will take care to properly escape the generated string expression, avoiding eventual string injection attacks** (_on the client-side this is not much of an issue_).

```js
const records = await pb.collection("example").getList(1, 20, {
  // the same as: "title ~ 'te\\'st' && (totalA = 123 || totalB = 123)"
  filter: pb.filter("title ~ {:title} && (totalA = {:num} || totalB = {:num})", { title: "te'st", num: 123 })
})
```

The supported placeholder parameter values are:

- `string`
- `number`
- `boolean`
- `null`
- `undefined` (stringified as `null`)
- `Date` object (stringified into the format expected by PocketBase)
- everything else is converted to a string using `JSON.stringify()`


### File upload

PocketBase Web API supports file upload via `multipart/form-data` requests,
which means that to upload a file it is enough to provide either a [`FormData`](https://developer.mozilla.org/en-US/docs/Web/API/FormData) instance OR plain object with `File`/`Blob` prop values.

- Using plain object as body _(this is the same as above and it will be converted to `FormData` behind the scenes)_:
    ```js
    const data = {
      'title':    'lorem ipsum...',
      'document': new File(...),
    };

    await pb.collection('example').create(data);
    ```

- Using `FormData` as body:
    ```js
    // the standard way to create multipart/form-data body
    const data = new FormData();
    data.set('title', 'lorem ipsum...')
    data.set('document', new File(...))

    await pb.collection('example').create(data);
    ```

### Error handling

All services return a standard [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)-based response, so the error handling is straightforward:
```js
pb.collection('example').getList(1, 50).then((result) => {
  // success...
  console.log('Result:', result);
}).catch((error) => {
  // error...
  console.log('Error:', error);
});

// OR if you are using the async/await syntax:
try {
  const result = await pb.collection('example').getList(1, 50);
  console.log('Result:', result);
} catch (error) {
  console.log('Error:', error);
}
```

The response error is normalized and always returned as `ClientResponseError` object with the following public fields that you could use:
```js
ClientResponseError {
    url:           string,     // requested url
    status:        number,     // response status code
    response:      { ... },    // the API JSON error response
    isAbort:       boolean,    // is abort/cancellation error
    originalError: Error|null, // the original non-normalized error
}
```

### Auth store

The SDK keeps track of the authenticated token and auth model for you via the `pb.authStore` instance.

##### LocalAuthStore (default)

The default [`LocalAuthStore`](https://github.com/pocketbase/js-sdk/blob/master/src/stores/LocalAuthStore.ts) uses the browser's `LocalStorage` if available, otherwise - will fallback to runtime/memory (aka. on page refresh or service restart you'll have to authenticate again).

Conveniently, the default store also takes care to automatically sync the auth store state between multiple tabs.

> _**NB!** Deno also supports `LocalStorage` but keep in mind that, unlike in browsers where the client is the only user, by default Deno `LocalStorage` will be shared by all clients making requests to your server!_

##### AsyncAuthStore

The SDK comes also with a helper [`AsyncAuthStore`](https://github.com/pocketbase/js-sdk/blob/master/src/stores/AsyncAuthStore.ts) that you can use to integrate with any 3rd party async storage implementation (_usually this is needed when working with React Native_):
```js
import AsyncStorage from '@react-native-async-storage/async-storage';
import PocketBase, { AsyncAuthStore } from 'pocketbase';

const store = new AsyncAuthStore({
    save:    async (serialized) => AsyncStorage.setItem('pb_auth', serialized),
    initial: AsyncStorage.getItem('pb_auth'),
});

const pb = new PocketBase('http://127.0.0.1:8090', store)
```

##### Custom auth store

In some situations it could be easier to create your own custom auth store. For this you can extend [`BaseAuthStore`](https://github.com/pocketbase/js-sdk/blob/master/src/stores/BaseAuthStore.ts) and pass the new custom instance as constructor argument to the client:

```js
import PocketBase, { BaseAuthStore } from 'pocketbase';

class CustomAuthStore extends BaseAuthStore {
    save(token, model) {
        super.save(token, model);

        // your custom business logic...
    }
}

const pb = new PocketBase('http://127.0.0.1:8090', new CustomAuthStore());
```

##### Common auth store fields and methods

The default `pb.authStore` extends [`BaseAuthStore`](https://github.com/pocketbase/js-sdk/blob/master/src/stores/BaseAuthStore.ts) and has the following public members that you can use:

```js
BaseAuthStore {
    // base fields
    record:       RecordModel|null // the authenticated auth record
    token:        string  // the authenticated token
    isValid:      boolean // checks if the store has existing and unexpired token
    isSuperuser:  boolean // checks if the store state is for superuser

    // main methods
    clear()             // "logout" the authenticated record
    save(token, record) // update the store with the new auth data
    onChange(callback, fireImmediately = false) // register a callback that will be called on store change

    // cookie parse and serialize helpers
    loadFromCookie(cookieHeader, key = 'pb_auth')
    exportToCookie(options = {}, key = 'pb_auth')
}
```

To _"logout"_ the authenticated record you can call `pb.authStore.clear()`.

To _"listen"_ for changes in the auth store, you can register a new listener via `pb.authStore.onChange`, eg:
```js
// triggered everytime on store change
const removeListener1 = pb.authStore.onChange((token, record) => {
    console.log('New store data 1:', token, record)
});

// triggered once right after registration and everytime on store change
const removeListener2 = pb.authStore.onChange((token, record) => {
    console.log('New store data 2:', token, record)
}, true);

// (optional) removes the attached listeners
removeListener1();
removeListener2();
```


### Auto cancellation

The SDK client will auto cancel duplicated pending requests for you.
For example, if you have the following 3 duplicated endpoint calls, only the last one will be executed, while the first 2 will be cancelled with `ClientResponseError` error:

```js
pb.collection('example').getList(1, 20) // cancelled
pb.collection('example').getList(2, 20) // cancelled
pb.collection('example').getList(3, 20) // executed
```

To change this behavior per request basis, you can adjust the `requestKey: null|string` special query parameter.
Set it to `null` to unset the default request identifier and to disable auto cancellation for the specific request.
Or set it to a unique string that will be used as request identifier and based on which pending requests will be matched (default to `HTTP_METHOD + path`, eg. "GET /api/users")

If you want to globally disable the auto cancellation behavior, you could set `pb.autoCancellation(false)`.

Examples:

```js
pb.collection('example').getList(1, 20);                        // cancelled
pb.collection('example').getList(1, 20);                        // executed
pb.collection('example').getList(1, 20, { requestKey: "test" }) // cancelled
pb.collection('example').getList(1, 20, { requestKey: "test" }) // executed
pb.collection('example').getList(1, 20, { requestKey: null })   // executed
pb.collection('example').getList(1, 20, { requestKey: null })   // executed

// globally disable auto cancellation
pb.autoCancellation(false);

pb.collection('example').getList(1, 20); // executed
pb.collection('example').getList(1, 20); // executed
pb.collection('example').getList(1, 20); // executed
```

If you want to manually cancel pending requests, you could use `pb.cancelAllRequests()` or `pb.cancelRequest(requestKey)`.


### Specify TypeScript definitions

You could specify custom TypeScript definitions for your Record models using generics:

```ts
interface Task {
  // type the collection fields you want to use...
  id:   string;
  name: string;
}

pb.collection('tasks').getList<Task>(1, 20) // -> results in Promise<ListResult<Task>>
pb.collection('tasks').getOne<Task>("RECORD_ID")  // -> results in Promise<Task>
```

Alternatively, if you don't want to type the generic argument every time you can define a global PocketBase type using type assertion:

```ts
interface Task {
  id:   string;
  name: string;
}

interface Post {
  id:     string;
  title:  string;
  active: boolean;
}

interface TypedPocketBase extends PocketBase {
  collection(idOrName: string): RecordService // default fallback for any other collection
  collection(idOrName: 'tasks'): RecordService<Task>
  collection(idOrName: 'posts'): RecordService<Post>
}

...

const pb = new PocketBase("http://127.0.0.1:8090") as TypedPocketBase;

pb.collection('tasks').getOne("RECORD_ID") // -> results in Promise<Task>
pb.collection('posts').getOne("RECORD_ID") // -> results in Promise<Post>
```


### Custom request options

All API services accept an optional `options` argument (usually the last one and of type [`SendOptions`](https://github.com/pocketbase/js-sdk/blob/master/src/tools/options.ts)), that can be used to provide:

- custom headers for a single request
- custom fetch options
- or even your own `fetch` implementation

For example:

```js
pb.collection('example').getList(1, 20, {
    expand:          'someRel',
    otherQueryParam: '123',

    // custom headers
    headers: {
        'X-Custom-Header': 'example',
    },

    // custom fetch options
    keepalive: false,
    cache:     'no-store',

    // or custom fetch implementation
    fetch: async (url, config) => { ... },
})
```

_Note that for backward compatability and to minimize the verbosity, any "unknown" top-level field will be treated as query parameter._


### Send hooks

Sometimes you may want to modify the request data globally or to customize the response.

To accomplish this, the SDK provides 2 function hooks:

- `beforeSend` - triggered right before sending the `fetch` request, allowing you to inspect/modify the request config.
    ```js
    const pb = new PocketBase('http://127.0.0.1:8090');

    pb.beforeSend = function (url, options) {
        // For list of the possible request options properties check
        // https://developer.mozilla.org/en-US/docs/Web/API/fetch#options
        options.headers = Object.assign({}, options.headers, {
            'X-Custom-Header': 'example',
        });

        return { url, options };
    };

    // use the created client as usual...
    ```

- `afterSend` - triggered after successfully sending the `fetch` request, allowing you to inspect/modify the response object and its parsed data.
    ```js
    const pb = new PocketBase('http://127.0.0.1:8090');

    pb.afterSend = function (response, data) {
        // do something with the response state
        console.log(response.status);

        return Object.assign(data, {
            // extend the data...
            "additionalField": 123,
        });
    };

    // use the created client as usual...
    ```

### SSR integration

Unfortunately, **there is no "one size fits all" solution** because each framework handle SSR differently (_and even in a single framework there is more than one way of doing things_).

But in general, the idea is to use a cookie based flow:

1. Create a new `PocketBase` instance for each server-side request
2. "Load/Feed" your `pb.authStore` with data from the request cookie
3. Perform your application server-side actions
4. Before returning the response to the client, update the cookie with the latest `pb.authStore` state

All [`BaseAuthStore`](https://github.com/pocketbase/js-sdk/blob/master/src/stores/BaseAuthStore.ts) instances have 2 helper methods that
should make working with cookies a little bit easier:

```js
// update the store with the parsed data from the cookie string
pb.authStore.loadFromCookie('pb_auth=...');

// exports the store data as cookie, with option to extend the default SameSite, Secure, HttpOnly, Path and Expires attributes
pb.authStore.exportToCookie({ httpOnly: false }); // Output: 'pb_auth=...'
```

Below you could find several examples:

<details>
  <summary><strong>SvelteKit</strong></summary>

One way to integrate with SvelteKit SSR could be to create the PocketBase client in a [hook handle](https://kit.svelte.dev/docs/hooks#handle)
and pass it to the other server-side actions using the `event.locals`.

```js
// src/hooks.server.js
import PocketBase from 'pocketbase';

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
    event.locals.pb = new PocketBase('http://127.0.0.1:8090');

    // load the store data from the request cookie string
    event.locals.pb.authStore.loadFromCookie(event.request.headers.get('cookie') || '');

    try {
        // get an up-to-date auth store state by verifying and refreshing the loaded auth model (if any)
        event.locals.pb.authStore.isValid && await event.locals.pb.collection('users').authRefresh();
    } catch (_) {
        // clear the auth store on failed refresh
        event.locals.pb.authStore.clear();
    }

    const response = await resolve(event);

    // send back the default 'pb_auth' cookie to the client with the latest store state
    response.headers.append('set-cookie', event.locals.pb.authStore.exportToCookie());

    return response;
}
```

And then, in some of your server-side actions, you could directly access the previously created `event.locals.pb` instance:

```js
// src/routes/login/+server.js
/**
 * Creates a `POST /login` server-side endpoint
 *
 * @type {import('./$types').RequestHandler}
 */
export async function POST({ request, locals }) {
    const { email, password } = await request.json();

    const { token, record } = await locals.pb.collection('users').authWithPassword(email, password);

    return new Response('Success...');
}
```

For proper `locals.pb` type detection, you can also add `PocketBase` in your your global types definition:

```ts
// src/app.d.ts
import PocketBase from 'pocketbase';

declare global {
    declare namespace App {
        interface Locals {
            pb: PocketBase
        }
    }
}
```
</details>

<details>
  <summary><strong>Astro</strong></summary>

To integrate with Astro SSR, you could create the PocketBase client in the [Middleware](https://docs.astro.build/en/guides/middleware) and pass it to the Astro components using the `Astro.locals`.

```ts 
// src/middleware/index.ts
import PocketBase from 'pocketbase';

import { defineMiddleware } from 'astro/middleware';

export const onRequest = defineMiddleware(async ({ locals, request }: any, next: () => any) => {
    locals.pb = new PocketBase('http://127.0.0.1:8090');

    // load the store data from the request cookie string
    locals.pb.authStore.loadFromCookie(request.headers.get('cookie') || '');

    try {
        // get an up-to-date auth store state by verifying and refreshing the loaded auth record (if any)
        locals.pb.authStore.isValid && await locals.pb.collection('users').authRefresh();
    } catch (_) {
        // clear the auth store on failed refresh
        locals.pb.authStore.clear();
    }

    const response = await next();

    // send back the default 'pb_auth' cookie to the client with the latest store state
    response.headers.append('set-cookie', locals.pb.authStore.exportToCookie());

    return response;
});
```

And then, in your Astro file's component script, you could directly access the previously created `locals.pb` instance:

```ts
// src/pages/index.astro
---
const locals = Astro.locals;

const userAuth = async () => {
    const { token, record } = await locals.pb.collection('users').authWithPassword('test@example.com', '123456');

    return new Response('Success...');
};
---
```

Although middleware functionality is available in both `SSG` and `SSR` projects, you would likely want to handle any sensitive data on the server side. Update your `output` configuration to `'server'`:

```mjs
// astro.config.mjs
import { defineConfig } from 'astro/config';

export default defineConfig({
    output: 'server'
});
```
</details>

<details>
  <summary><strong>Nuxt 3</strong></summary>

One way to integrate with Nuxt 3 SSR could be to create the PocketBase client in a [nuxt plugin](https://v3.nuxtjs.org/guide/directory-structure/plugins)
and provide it as a helper to the `nuxtApp` instance:

```js
// plugins/pocketbase.js
import PocketBase from 'pocketbase';

export default defineNuxtPlugin(async () => {
  const pb = new PocketBase('http://127.0.0.1:8090');

  const cookie = useCookie('pb_auth', {
    path:     '/',
    secure:   true,
    sameSite: 'strict',
    httpOnly: false, // change to "true" if you want only server-side access
    maxAge:   604800,
  })

  // load the store data from the cookie value
  pb.authStore.save(cookie.value?.token, cookie.value?.record);

  // send back the default 'pb_auth' cookie to the client with the latest store state
  pb.authStore.onChange(() => {
    cookie.value = {
      token: pb.authStore.token,
      record: pb.authStore.record,
    };
  });

  try {
      // get an up-to-date auth store state by verifying and refreshing the loaded auth model (if any)
      pb.authStore.isValid && await pb.collection('users').authRefresh();
  } catch (_) {
      // clear the auth store on failed refresh
      pb.authStore.clear();
  }

  return {
    provide: { pb }
  }
});
```

And then in your component you could access it like this:

```html
<template>
  <div>
    Show: {{ data }}
  </div>
</template>

<script setup>
  const { data } = await useAsyncData(async (nuxtApp) => {
    // fetch and return all "example" records...
    const records = await nuxtApp.$pb.collection('example').getFullList();

    return structuredClone(records);
  })
</script>
```
</details>

<details>
  <summary><strong>Nuxt 2</strong></summary>

One way to integrate with Nuxt 2 SSR could be to create the PocketBase client in a [nuxt plugin](https://nuxtjs.org/docs/directory-structure/plugins#plugins-directory) and provide it as a helper to the `$root` context:

```js
// plugins/pocketbase.js
import PocketBase from  'pocketbase';

export default async (ctx, inject) => {
  const pb = new PocketBase('http://127.0.0.1:8090');

  // load the store data from the request cookie string
  pb.authStore.loadFromCookie(ctx.req?.headers?.cookie || '');

  // send back the default 'pb_auth' cookie to the client with the latest store state
  pb.authStore.onChange(() => {
    ctx.res?.setHeader('set-cookie', pb.authStore.exportToCookie());
  });

  try {
      // get an up-to-date auth store state by verifying and refreshing the loaded auth record (if any)
      pb.authStore.isValid && await pb.collection('users').authRefresh();
  } catch (_) {
      // clear the auth store on failed refresh
      pb.authStore.clear();
  }

  inject('pocketbase', pb);
};
```

And then in your component you could access it like this:

```html
<template>
  <div>
    Show: {{ items }}
  </div>
</template>

<script>
  export default {
    async asyncData({ $pocketbase }) {
      // fetch and return all "example" records...
      const items = await $pocketbase.collection('example').getFullList();

      return { items }
    }
  }
</script>
```
</details>

<details>
  <summary><strong>Next.js</strong></summary>

Next.js doesn't seem to have a central place where you can read/modify the server request and response.
[There is support for middlewares](https://nextjs.org/docs/advanced-features/middleware),
but they are very limited and, at the time of writing, you can't pass data from a middleware to the `getServerSideProps` functions (https://github.com/vercel/next.js/discussions/31792).

One way to integrate with Next.js SSR could be to create a custom `PocketBase` instance in each of your `getServerSideProps`:

```jsx
import PocketBase from 'pocketbase';

// you can place this helper in a separate file so that it can be reused
async function initPocketBase(req, res) {
  const pb = new PocketBase('http://127.0.0.1:8090');

  // load the store data from the request cookie string
  pb.authStore.loadFromCookie(req?.headers?.cookie || '');

  // send back the default 'pb_auth' cookie to the client with the latest store state
  pb.authStore.onChange(() => {
    res?.setHeader('set-cookie', pb.authStore.exportToCookie());
  });

  try {
      // get an up-to-date auth store state by verifying and refreshing the loaded auth record (if any)
      pb.authStore.isValid && await pb.collection('users').authRefresh();
  } catch (_) {
      // clear the auth store on failed refresh
      pb.authStore.clear();
  }

  return pb
}

export async function getServerSideProps({ req, res }) {
  const pb = await initPocketBase(req, res)

  // fetch example records...
  const result = await pb.collection('example').getList(1, 30);

  return {
    props: {
      // ...
    },
  }
}

export default function Home() {
  return (
    <div>Hello world!</div>
  )
}
```
</details>

### Security

The most common frontend related vulnerability is XSS (and CSRF when dealing with cookies).
Fortunately, modern browsers can detect and mitigate most of this type of attacks if [Content Security Policy (CSP)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP) is provided.

**To prevent a malicious user or 3rd party script to steal your PocketBase auth token, it is recommended to configure a basic CSP for your application (either as `meta` tag or HTTP header).**

This is out of the scope of the SDK, but you could find more resources about CSP at:

- https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
- https://content-security-policy.com


**Depending on how and where you use the JS SDK, it is also recommended to use the helper `pb.filter(expr, params)` when constructing filter strings with untrusted user input to avoid eventual string injection attacks (see [Binding filter parameters](#binding-filter-parameters)).**


## Definitions

### Creating new client instance

```js
const pb = new PocketBase(baseURL = '/', authStore = LocalAuthStore);
```

### Instance methods

> Each instance method returns the `PocketBase` instance allowing chaining.

| Method                            | Description                                                                   |
|:----------------------------------|:------------------------------------------------------------------------------|
| `pb.send(path, sendOptions = {})` | Sends an api http request.                                                    |
| `pb.autoCancellation(enable)`     | Globally enable or disable auto cancellation for pending duplicated requests. |
| `pb.cancelAllRequests()`          | Cancels all pending requests.                                                 |
| `pb.cancelRequest(cancelKey)`     | Cancels single request by its cancellation token key.                         |
| `pb.buildURL(path)`               | Builds a full client url by safely concatenating the provided path.           |


### Services

> Each service call returns a `Promise` object with the API response.

##### RecordService

###### _Crud handlers_

```js
// Returns a paginated records list.
🔓 pb.collection(collectionIdOrName).getList(page = 1, perPage = 30, options = {});

// Returns a list with all records batch fetched at once
// (by default 1000 items per request; to change it set the `batch` param).
🔓 pb.collection(collectionIdOrName).getFullList(options = {});

// Returns the first found record matching the specified filter.
🔓 pb.collection(collectionIdOrName).getFirstListItem(filter, options = {});

// Returns a single record by its id.
🔓 pb.collection(collectionIdOrName).getOne(recordId, options = {});

// Creates (aka. register) a new record.
🔓 pb.collection(collectionIdOrName).create(bodyParams = {}, options = {});

// Updates an existing record by its id.
🔓 pb.collection(collectionIdOrName).update(recordId, bodyParams = {}, options = {});

// Deletes a single record by its id.
🔓 pb.collection(collectionIdOrName).delete(recordId, options = {});

```

###### _Realtime handlers_

```js
// Subscribe to realtime changes to the specified topic ("*" or recordId).
//
// It is safe to subscribe multiple times to the same topic.
//
// You can use the returned UnsubscribeFunc to remove a single registered subscription.
// If you want to remove all subscriptions related to the topic use unsubscribe(topic).
🔓 pb.collection(collectionIdOrName).subscribe(topic, callback, options = {});

// Unsubscribe from all registered subscriptions to the specified topic ("*" or recordId).
// If topic is not set, then it will remove all registered collection subscriptions.
🔓 pb.collection(collectionIdOrName).unsubscribe([topic]);
```

###### _Auth handlers_

> Available only for "auth" type collections.

```js
// Returns all available application auth methods.
🔓 pb.collection(collectionIdOrName).listAuthMethods(options = {});

// Authenticates a record with their username/email and password.
🔓 pb.collection(collectionIdOrName).authWithPassword(usernameOrEmail, password, options = {});

// Authenticates a record with an OTP.
🔓 pb.collection(collectionIdOrName).authWithOTP(otpId, password, options = {});

// Authenticates a record with OAuth2 provider without custom redirects, deeplinks or even page reload.
🔓 pb.collection(collectionIdOrName).authWithOAuth2(authConfig);

// Authenticates a record with OAuth2 code.
🔓 pb.collection(collectionIdOrName).authWithOAuth2Code(provider, code, codeVerifier, redirectUrl, createData = {}, options = {});

// Refreshes the current authenticated record and auth token.
🔐 pb.collection(collectionIdOrName).authRefresh(options = {});

// Sends a record OTP email request.
🔓 pb.collection(collectionIdOrName).requestOTP(email, options = {});

// Sends a record password reset email.
🔓 pb.collection(collectionIdOrName).requestPasswordReset(email, options = {});

// Confirms a record password reset request.
🔓 pb.collection(collectionIdOrName).confirmPasswordReset(resetToken, newPassword, newPasswordConfirm, options = {});

// Sends a record verification email request.
🔓 pb.collection(collectionIdOrName).requestVerification(email, options = {});

// Confirms a record email verification request.
🔓 pb.collection(collectionIdOrName).confirmVerification(verificationToken, options = {});

// Sends a record email change request to the provider email.
🔐 pb.collection(collectionIdOrName).requestEmailChange(newEmail, options = {});

// Confirms record new email address.
🔓 pb.collection(collectionIdOrName).confirmEmailChange(emailChangeToken, userPassword, options = {});

// Lists all linked external auth providers for the specified record.
🔐 pb.collection(collectionIdOrName).listExternalAuths(recordId, options = {});

// Unlinks a single external auth provider relation from the specified record.
🔐 pb.collection(collectionIdOrName).unlinkExternalAuth(recordId, provider, options = {});

// Impersonate authenticates with the specified recordId and returns a new client with the received auth token in a memory store.
🔐 pb.collection(collectionIdOrName).impersonate(recordId, duration, options = {});
```

---

#### BatchService

```js
// create a new batch instance
const batch = pb.createBatch();

// register create/update/delete/upsert requests to the created batch
batch.collection('example1').create({ ... });
batch.collection('example2').update('RECORD_ID', { ... });
batch.collection('example3').delete('RECORD_ID');
batch.collection('example4').upsert({ ... });

// send the batch request
const result = await batch.send()
```

---

##### FileService

```js
// Builds and returns an absolute record file url for the provided filename.
🔓 pb.files.getURL(record, filename, options = {});

// Requests a new private file access token for the current authenticated record.
🔐 pb.files.getToken(options = {});
```

---

##### CollectionService

```js
// Returns a paginated collections list.
🔐 pb.collections.getList(page = 1, perPage = 30, options = {});

// Returns a list with all collections batch fetched at once
// (by default 200 items per request; to change it set the `batch` query param).
🔐 pb.collections.getFullList(options = {});

// Returns the first found collection matching the specified filter.
🔐 pb.collections.getFirstListItem(filter, options = {});

// Returns a single collection by its id or name.
🔐 pb.collections.getOne(idOrName, options = {});

// Creates (aka. register) a new collection.
🔐 pb.collections.create(bodyParams = {}, options = {});

// Updates an existing collection by its id or name.
🔐 pb.collections.update(idOrName, bodyParams = {}, options = {});

// Deletes a single collection by its id or name.
🔐 pb.collections.delete(idOrName, options = {});

// Deletes all records associated with the specified collection.
🔐 pb.collections.truncate(idOrName, options = {});

// Imports the provided collections.
🔐 pb.collections.import(collections, deleteMissing = false, options = {});

// Returns type indexed map with scaffolded collection models populated with their default field values.
🔐 pb.collections.getScaffolds(options = {});

// Returns a list with all configurable OAuth2 providers.
🔐 pb.collections.getAllOAuth2Providers(options = {});

// Tests the specified view query and returns a sample of the resulting records.
🔐 pb.collections.dryRunViewQuery(query, options = {});
```

---

##### LogService

```js
// Returns a paginated logs list.
🔐 pb.logs.getList(page = 1, perPage = 30, options = {});

// Returns a single log by its id.
🔐 pb.logs.getOne(id, options = {});

// Returns logs statistics.
🔐 pb.logs.getStats(options = {});

// Delete all logs.
🔐 pb.logs.truncate(options = {});
```

---

##### SettingsService

```js
// Returns a map with all available app settings.
🔐 pb.settings.getAll(options = {});

// Bulk updates app settings.
🔐 pb.settings.update(bodyParams = {}, options = {});

// Performs a S3 storage connection test.
🔐 pb.settings.testS3(filesystem = "storage", options = {});

// Sends a test email (verification, password-reset, email-change).
🔐 pb.settings.testEmail(collectionIdOrName, toEmail, template, options = {});

// Generates a new Apple OAuth2 client secret.
🔐 pb.settings.generateAppleClientSecret(clientId, teamId, keyId, privateKey, duration, options = {});
```

---

##### RealtimeService

> This service is usually used with custom realtime actions.
> For records realtime subscriptions you can use the subscribe/unsubscribe
> methods available in the `pb.collection()` RecordService.

```js
// Initialize the realtime connection (if not already) and register the subscription listener.
//
// You can subscribe to the `PB_CONNECT` event if you want to listen to the realtime connection connect/reconnect events.
🔓 pb.realtime.subscribe(topic, callback, options = {});

// Unsubscribe from all subscription listeners with the specified topic.
🔓 pb.realtime.unsubscribe(topic?);

// Unsubscribe from all subscription listeners starting with the specified topic prefix.
🔓 pb.realtime.unsubscribeByPrefix(topicPrefix);

// Unsubscribe from all subscriptions matching the specified topic and listener function.
🔓 pb.realtime.unsubscribeByTopicAndListener(topic, callback);

// Getter that checks whether the realtime connection has been established.
pb.realtime.isConnected

// An optional hook that is invoked when the realtime client disconnects
// either when unsubscribing from all subscriptions or when the connection
// was interrupted or closed by the server.
//
// Note that the realtime client autoreconnect on its own and this hook is
// useful only for the cases where you want to apply a special behavior on
// server error or after closing the realtime connection.
pb.realtime.onDisconnect = function(activeSubscriptions)
```

---

##### BackupService

```js
// Returns list with all available backup files.
🔐 pb.backups.getFullList(options = {});

// Initializes a new backup.
🔐 pb.backups.create(basename = "", options = {});

// Upload an existing app data backup.
🔐 pb.backups.upload({ file: File/Blob }, options = {});

// Deletes a single backup by its name.
🔐 pb.backups.delete(key, options = {});

// Initializes an app data restore from an existing backup.
🔐 pb.backups.restore(key, options = {});

// Builds a download url for a single existing backup using a
// superuser file token and the backup file key.
🔐 pb.backups.getDownloadURL(token, key);
```

##### CronService

```js
// Returns list with all available cron jobs.
🔐 pb.crons.getFullList(options = {});

// Runs the specified cron job.
🔐 pb.crons.run(jobId, options = {});
```

##### SQLService

```js
// Runs the specified raw SQL query.
🔐 pb.sql.run(query, options = {});
```

---

##### HealthService

```js
// Checks the health status of the api.
🔓 pb.health.check(options = {});
```


## Development

Bun runs everything here. The build runs rollup on Bun's runtime (`bun --bun rollup`) because `rollup-plugin-ts` uses the old `import ... assert` syntax that Node 22 and later reject; upstream asks for Node <= 21 for the same reason.

```sh
bun install

# run unit tests (upstream's and this package's)
bunx vitest run

# run prettier
bun run format

# build and minify for production: the main entry and the plugin entries (offline, pwa, editable)
bun run build
```

`dist/` is committed, as upstream does, so rebuild before a release.

### Keeping in step with upstream

The `upstream` remote is [pocketbase/js-sdk](https://github.com/pocketbase/js-sdk). The additions live in their own files (`src/VoidBase.ts`, `src/tools/plugin.ts`, `src/offline.ts`, `src/pwa.ts`, `src/editable.ts` and their tests) and touch `src/Client.ts` in three contained places (the `hooks` property, `use`/`unuse`/`plugins`, and the tail of `send()` where the hook lists run), so an upstream release merges with little to reconcile:

```sh
git fetch upstream
git merge upstream/master
bunx vitest run
```

Then bump the `0.x` version, note which upstream version it tracks in the CHANGELOG, and rebuild.
