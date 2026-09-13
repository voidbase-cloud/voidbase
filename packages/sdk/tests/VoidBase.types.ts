// Type-level checks for VoidBase. This file is not run; tests/VoidBase.spec.ts
// compiles it with `tsc -p tests/tsconfig.types.json` and asserts a clean
// exit. A `@ts-expect-error` line that stops erroring fails that compile, so
// each one below is a proof that the marked access is a compile error.

import { VoidBase, RecordService, RecordModel, ListResult, Plugin } from "@/index";
import { offline, OfflineQueue, Mutation, OfflineClient } from "@/offline";
import { i18n, Translate, I18nClient } from "@/i18n";

// the shape `voidbase types` writes: one interface per collection, no index
// signature, and a Collections interface keyed by collection name
interface PostsRecord {
    id: string;
    collectionId: string;
    collectionName: "posts";
    title: string;
    author: string;
    expand?: { author?: UsersRecord };
}
interface UsersRecord {
    id: string;
    collectionId: string;
    collectionName: "users";
    email: string;
    expand?: Record<string, unknown>;
}
interface Collections {
    posts: PostsRecord;
    users: UsersRecord;
}

const pb = new VoidBase<Collections>("http://127.0.0.1:8090");

// a known name is bound to its record type
const posts: RecordService<PostsRecord> = pb.collection("posts");
const users: RecordService<UsersRecord> = pb.collection("users");

async function typed() {
    const post = await posts.getOne("RECORD_ID");
    const title: string = post.title;
    const author: UsersRecord | undefined = post.expand?.author;

    // a wrong field is a compile error
    // @ts-expect-error `titel` is not a field of PostsRecord
    post.titel;

    // @ts-expect-error a number is not a string
    const wrongType: number = post.title;

    const list: ListResult<UsersRecord> = await users.getList(1, 20);
    const email: string = list.items[0].email;

    // the body of create/update is typed loosely on purpose (it may carry
    // password and passwordConfirm, or be FormData), so this compiles
    await posts.create({ title: "hello", author: "USER_ID" });

    return [title, author, wrongType, email];
}

// a name the map does not know is untyped, as the plain client answers it
const other: RecordService<RecordModel> = pb.collection("_superusers");
const explicit: RecordService<{ id: string; custom: number }> =
    pb.collection<{ id: string; custom: number }>("anything");

// without a type argument every name is untyped
const untyped = new VoidBase("http://127.0.0.1:8090");
const any1: RecordService<RecordModel> = untyped.collection("posts");

// VoidBase is a Client: the rest of the surface is unchanged
const url: string = pb.buildURL("/api/health");
const filter: string = pb.filter("title = {:t}", { t: "x" });

// a plugin that names what it attaches types the client it is used on
interface Counter {
    count(): number;
}
const counting: Plugin<{ counter: Counter }> = {
    name: "counting",
    install(client) {
        (client as any).counter = { count: () => client.hooks.beforeSend.size };
    },
};
const withCounter = pb.use(counting);
const count: number = withCounter.counter.count();
const stillTyped: RecordService<PostsRecord> = withCounter.collection("posts");

// a plugin that attaches nothing leaves the client as it is
const plain = pb.use({ name: "plain", install() {} });
// @ts-expect-error nothing was attached
plain.counter;
const names: string[] = plain.plugins;

// hook removers are functions
const removeBefore: () => void = pb.hooks.beforeSend.add((url, options) => ({ url, options }));
const removeAfter: () => void = pb.hooks.afterSend.add((_response, data) => data);
const removeError: () => void = pb.hooks.onError.add((err, request) => {
    const status: number = err.status;
    const failedUrl: string = request.url;
    return status === 0 ? { offline: failedUrl } : undefined;
});

// the offline plugin types client.offline through use()
const withOffline = pb.use(offline({ key: "queue" }));
const queue: OfflineQueue = withOffline.offline;
const pendingMutations: Mutation[] = queue.pending();
const offlinePosts: RecordService<PostsRecord> = withOffline.collection("posts");
const asOfflineClient: OfflineClient<VoidBase<Collections>> = withOffline;
const unsubscribe: () => void = queue.on("failed", ({ mutation, error }) => {
    const op: "create" | "update" | "delete" = mutation.op;
    const status: number = error.status;
    return [op, status];
});

// the i18n plugin types client.i18n, narrowed to the MessageKey that
// `voidbase i18n extract` writes to i18n/keys.d.ts
type MessageKey = "greeting" | "nav.home";
const withI18n = pb.use(
    i18n<MessageKey>({ catalogues: { en: { greeting: "Hello", "nav.home": "Home" } } }),
);
const greeting: string = withI18n.i18n.t("greeting");
const interpolated: string = withI18n.i18n.t("nav.home", { name: "Ada", count: 2 });
// @ts-expect-error "farewell" is not a MessageKey, aka nothing calls it any more
withI18n.i18n.t("farewell");
const translate: Translate<MessageKey> = withI18n.i18n.t;
const localeNames: string[] = withI18n.i18n.locales;
const asI18nClient: I18nClient<VoidBase<Collections>, MessageKey> = withI18n;
const i18nPosts: RecordService<PostsRecord> = withI18n.collection("posts");

// without a type argument any string is a key
const looseI18n = new VoidBase("http://127.0.0.1:8090").use(i18n({ catalogues: {} }));
const anyKey: string = looseI18n.i18n.t("anything");

export {
    withOffline,
    pendingMutations,
    offlinePosts,
    asOfflineClient,
    unsubscribe,
    typed,
    other,
    explicit,
    any1,
    url,
    filter,
    count,
    stillTyped,
    names,
    removeBefore,
    removeAfter,
    removeError,
    greeting,
    interpolated,
    translate,
    localeNames,
    asI18nClient,
    i18nPosts,
    anyKey,
};
