// The record context slot, read by a file that fills nothing.
//
// `bun test` runs every file in one process and src/server/record-slot.ts holds the slot in a module global, so a
// test that fills it with a stub of its own leaves that stub to whatever runs next. plugin-seams.test.ts fills it
// (its seo and auth-refresh tests need to see the slot asked) and puts it back with resetRecordContext(); this
// file is the proof that it did, which is why it does nothing but read: it sorts after plugin-seams.test.ts, so
// with the stub left in place it sees the stub, and with the slot restored it sees the empty slot's own refusal.
//   bun test test/unit/plugin-seams.test.ts test/unit/plugin-slot-restored.test.ts
import { expect, test } from "bun:test";
import { recordContextFor } from "../../src/server/record-slot";
import type { AppEnv } from "../../src/server/types";
import type { Context } from "hono";

const request = { req: { path: "/api/collections/posts/records" } } as unknown as Context<AppEnv>;

test("no test file's stub is left in the slot: an unfilled slot says it is unfilled", () => {
  expect(() => recordContextFor(request)).toThrow("nothing has filled the record context slot");
});
