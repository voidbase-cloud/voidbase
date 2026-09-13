// Updating an instance on Cloudflare from the CLI: which instances a release may be uploaded onto, and what is kept.
import { expect, test } from "bun:test";
import { updatePlan } from "../../src/node/cloud-update";

test("an instance provisioned from a release is updated, and its other tags are kept", () => {
  const plan = updatePlan("shop", ["voidbase", "voidbase-release:0.9.0-beta.40-20260910.1200", "vbcloud-owner:u1"]);
  expect(plan).toEqual({ ok: true, from: "0.9.0-beta.40-20260910.1200", keepTags: ["vbcloud-owner:u1"] });
});

test("an instance deployed from a project is refused, because a release would replace its hooks and plugins", () => {
  const plan = updatePlan("blog", []);
  expect(plan.ok).toBe(false);
  if (!plan.ok) {
    expect(plan.reason).toContain("deployed from a project");
    expect(plan.reason).toContain("voidbase deploy");
  }
});

test("a Worker the account does not have is refused by name", () => {
  const plan = updatePlan("vbstories-missing", null);
  expect(plan.ok).toBe(false);
  if (!plan.ok) expect(plan.reason).toContain("no Worker called vbstories-missing");
});
