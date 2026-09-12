import { describe, expect, test } from "bun:test";
import { publicMembers, rosterAfter, type PresenceMember } from "../../src/server/realtime/presence";

const opts = (now: number, max = 3, ttlMs = 12_000) => ({ max, ttlMs, now });
const join = (members: PresenceMember[], id: string, now: number, extra: Record<string, unknown> = {}) =>
  rosterAfter(members, "join", { id, name: id, color: "#fff", ...extra }, opts(now)).members;

describe("presence roster", () => {
  test("the newest arrivals hold the slots: a fourth join evicts the one that joined first", () => {
    let m: PresenceMember[] = [];
    m = join(m, "a", 1000); m = join(m, "b", 2000); m = join(m, "c", 3000);
    expect(m.map((x) => x.id)).toEqual(["a", "b", "c"]);
    m = join(m, "d", 4000);
    expect(m.map((x) => x.id)).toEqual(["b", "c", "d"]);
  });
  test("a beat moves a member and is dropped from anyone without a slot: the write path is bounded", () => {
    let m = join(join([], "a", 1000), "b", 2000);
    const beat = rosterAfter(m, "beat", { id: "a", x: 42.5, y: 10 }, opts(2500));
    m = beat.members;
    expect(beat.member?.id).toBe("a");
    expect([m[0]!.x, m[0]!.y, m[0]!.seen]).toEqual([42.5, 10, 2500]);
    const stranger = rosterAfter(m, "beat", { id: "nobody", x: 5, y: 5 }, opts(2600));
    expect(stranger.member).toBeNull();
    expect(stranger.members.map((x) => x.id)).toEqual(["a", "b"]);
  });
  test("coordinates are clamped and text is bounded, whatever a client sends", () => {
    const m = join([], "a", 1000, { x: 1e6, y: -50, name: "x".repeat(200), color: "#".padEnd(80, "f") });
    expect([m[0]!.x, m[0]!.y]).toEqual([100, 0]);
    expect(m[0]!.name.length).toBe(24);
    expect(m[0]!.color.length).toBe(16);
    expect(join([], "", 1000)).toEqual([]);
  });
  test("a slot is freed by leaving, and by going quiet for the time to live", () => {
    let m = join(join([], "a", 1000), "b", 2000);
    m = rosterAfter(m, "leave", { id: "a" }, opts(2100)).members;
    expect(m.map((x) => x.id)).toEqual(["b"]);
    const later = rosterAfter(m, "join", { id: "c", name: "c" }, opts(2000 + 12_001));
    expect(later.members.map((x) => x.id)).toEqual(["c"]); // b was not heard from within the ttl
  });
  test("rejoining keeps the slot it already had rather than taking a second one", () => {
    let m = join(join(join([], "a", 1000), "b", 2000), "c", 3000);
    m = join(m, "b", 4000);
    expect(m.map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(m.find((x) => x.id === "b")!.joined).toBe(2000);
  });
  test("what a client is told carries no bookkeeping", () => {
    const m = join([], "a", 1000, { x: 10, y: 20 });
    expect(publicMembers(m)).toEqual([{ id: "a", name: "a", color: "#fff", x: 10, y: 20 }]);
  });
});
