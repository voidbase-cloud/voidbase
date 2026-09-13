// Creating an instance on Cloudflare from the CLI: which names may be created.
import { expect, test } from "bun:test";
import { createRefusal } from "../../src/node/cloud-create";

test("a free, valid name may be created", () => {
  expect(createRefusal("vbstories-e", false)).toBeNull();
});

test("a name a Worker already has is refused, pointing at update", () => {
  const why = createRefusal("shop", true);
  expect(why).toContain("already exists");
  expect(why).toContain("voidbase update --cloudflare shop");
});

test("a name Cloudflare would refuse is refused first", () => {
  expect(createRefusal("Shop_1", false)).toContain("is not a Worker name");
  expect(createRefusal("-shop", false)).toContain("is not a Worker name");
});
