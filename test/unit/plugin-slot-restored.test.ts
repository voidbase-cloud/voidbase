// The record context slot, read by a file that fills nothing of its own.
//
// `bun test` runs every file in one process and src/server/record-slot.ts holds the slot in a module global, so a
// test that borrows it has to give back exactly what it took. This file is the proof that every file before it
// did, and it says so without depending on which files those were: it reads the slot before anything here touches
// it, then loads app.ts, which is the one thing that fills the slot for real. Whatever was in the slot is then
// either nothing (no file before this one imported app.ts) or app.ts's own builder — and never a test's stub,
// which is what a file that borrowed the slot and did not give it back leaves behind.
//
// The order the files run in used to be the whole of why this worked: plugin-seams.test.ts emptied the slot, and
// plugin-entry-points.test.ts happened to sort first and import ./workflows, which imports ./app, so the slot it
// emptied was app.ts's. Run on its own, or first, it saw an empty slot and passed for the wrong reason. It holds
// either way now, and both orders are run:
//   bun test test/unit/plugin-seams.test.ts test/unit/plugin-slot-restored.test.ts
//   bun test test/unit/plugin-slot-restored.test.ts test/unit/plugin-seams.test.ts
import { expect, test } from "bun:test";
import { provideRecordContext, recordContextBuilder, restoreRecordContext, type RecordContextBuilder } from "../../src/server/record-slot";
import type { RecordContext } from "../../src/server/records/service";

// read before the import below, because that import fills the slot: a stub left by an earlier file is only
// visible until app.ts puts its own builder over it
const found = recordContextBuilder();
// app.ts calls provideRecordContext(recordContextFor) at module scope, and exports the same function
const { recordContextFor } = await import("../../src/server/app");

test("no test file's stub is left in the slot: it holds app.ts's own builder, or nothing has filled it", () => {
  expect(found ?? recordContextFor).toBe(recordContextFor);
});

test("and app.ts's builder is in it now, so a plugin that asks for a context after this file gets a real one", () => {
  expect(recordContextBuilder()).toBe(recordContextFor);
});

test("a borrow gives back what it took, which is the only way a file may touch the slot", () => {
  const mine: RecordContextBuilder = async () => ({ mine: true }) as unknown as RecordContext;
  const was = provideRecordContext(mine);
  expect(was).toBe(recordContextFor);
  restoreRecordContext(was);
  expect(recordContextBuilder()).toBe(recordContextFor);
});
