// What a realtime subscription topic means, and the one that used to mean nothing.
//
// PocketBase accepts three forms: `posts/<id>` for one record, `posts/*` for the collection, and a bare `posts`,
// which apis/realtime.go keeps as a deprecated alias for the wildcard (it maps `collection.Name + "?"` to the list
// rule exactly as it maps `collection.Name + "/*?"`). voidbase dropped the bare form, and dropped it silently:
// `POST /api/realtime` still answered 204, the client held a stream that could never match anything, and the only
// way to notice was to wait forever. Measured against the live demo on 2026-09-12: `["posts"]` saw nothing in 30
// seconds while `["posts/*"]` delivered the create on the same stream.
import { describe, expect, test } from "bun:test";
import { parseSubscription } from "../../src/server/realtime";

describe("subscription topics", () => {
  test("a bare collection name is the whole collection, as it is in PocketBase", () => {
    const bare = parseSubscription("posts");
    expect(bare).not.toBeNull();
    expect(bare!.collection).toBe("posts");
    expect(bare!.recordId).toBeNull();          // null is what routes it through the list rule
    expect(bare!.topic).toBe("posts");          // the topic is echoed as the client sent it
  });

  test("the wildcard and one record keep their meanings", () => {
    expect(parseSubscription("posts/*")).toMatchObject({ collection: "posts", recordId: null });
    expect(parseSubscription("posts/abc123")).toMatchObject({ collection: "posts", recordId: "abc123" });
  });

  test("a bare topic carries its options too, which the old order dropped on the floor", () => {
    const raw = `posts?options=${encodeURIComponent(JSON.stringify({ headers: { "X-Token": "t" }, query: { preview: "feature/x" } }))}`;
    const sub = parseSubscription(raw);
    expect(sub).not.toBeNull();
    expect(sub!.collection).toBe("posts");
    expect(sub!.recordId).toBeNull();
    expect(sub!.headers["x-token"]).toBe("t");   // header names arrive lowercased
    expect(sub!.query.preview).toBe("feature/x");
  });

  test("an empty topic is still nothing", () => {
    expect(parseSubscription("")).toBeNull();
  });

  test("the message topics are untouched", () => {
    expect(parseSubscription("@oauth2")).toMatchObject({ collection: "@oauth2", recordId: null });
  });
});
