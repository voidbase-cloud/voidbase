// Presence: who is here now, and where their cursor is, without writing a single row.
//
// The cost of a live cursor layer is fanout, not storage, so the shape here is chosen to bound the expensive half:
//
//   - at most `max` members hold a slot (the newest to arrive; the oldest is evicted), so however many people are
//     watching, only that many clients ever send anything. The write path is O(max), not O(visitors);
//   - a beat is one request to the instance's own hub (the Durable Object that already holds every SSE connection),
//     which updates the roster and fans it out to the sockets that asked for `presence`. Nothing touches D1, so the
//     database cost of a million watchers is zero;
//   - the roster lives in the object's memory with a time-to-live, so a client that closes its laptop frees its slot
//     without telling anyone, and an idle instance keeps nothing;
//   - one variable turns the whole thing off (`VOIDBASE_PRESENCE`), and the page that uses it is expected to fall
//     back to something canned. That is the switch to pull if the fanout ever costs more than it is worth.
//
// The fanout itself rides the existing subscription machinery: members are published as a change on the `presence`
// topic, so a client subscribes to it exactly as it subscribes to a collection (`pb.realtime.subscribe("presence")`)
// and no new protocol reaches the SDK.
import { env as runtimeEnv } from "#platform/env";

/** A member of the roster, as the server keeps it. */
export interface PresenceMember {
  id: string;
  name: string;
  color: string;
  /** where the cursor is, in the sender's own coordinates (a landing page sends percentages) */
  x: number;
  y: number;
  /** when the slot was taken, and when the last beat arrived */
  joined: number;
  seen: number;
}
export type PresenceOp = "join" | "beat" | "leave";
export interface PresenceInput { id: string; name?: string; color?: string; x?: number; y?: number }
export interface RosterOptions { max: number; ttlMs: number; now: number }

/** The topic a client subscribes to, and the record id the roster is published under. */
export const PRESENCE_TOPIC = "presence";
export const PRESENCE_RECORD = "roster";

const clamp = (v: unknown, lo: number, hi: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const text = (v: unknown, max: number, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);

/**
 * The roster after one operation, as a pure function so the rule is testable without a Durable Object:
 *
 *   join   the member takes a slot; a member of the same id is replaced, and once the roster is full the one that
 *          joined earliest loses its slot (the newest three, as the page promises)
 *   beat   an existing member moves; a beat from a member with no slot is ignored, which is what bounds the cost
 *   leave  the member gives up its slot
 *
 * Members that have not been heard from for `ttlMs` are dropped first, so a closed tab frees its slot on its own.
 */
export function rosterAfter(current: PresenceMember[], op: PresenceOp, input: PresenceInput, o: RosterOptions): { members: PresenceMember[]; changed: boolean; member: PresenceMember | null } {
  const id = text(input.id, 40);
  const alive = current.filter((m) => o.now - m.seen < o.ttlMs);
  let changed = alive.length !== current.length;
  const at = alive.findIndex((m) => m.id === id);

  if (!id) return { members: alive, changed, member: null };

  if (op === "leave") {
    if (at < 0) return { members: alive, changed, member: null };
    alive.splice(at, 1);
    return { members: alive, changed: true, member: null };
  }

  if (op === "beat") {
    const member = alive[at];
    if (!member) return { members: alive, changed, member: null }; // no slot: the beat is dropped, not queued
    member.x = clamp(input.x, 0, 100); member.y = clamp(input.y, 0, 100); member.seen = o.now;
    return { members: alive, changed: true, member };
  }

  // join: the newest arrivals hold the slots
  const member: PresenceMember = {
    id,
    name: text(input.name, 24, "Guest"),
    color: text(input.color, 16, "#8b8b9e"),
    x: clamp(input.x, 0, 100), y: clamp(input.y, 0, 100),
    joined: at >= 0 ? alive[at]!.joined : o.now,
    seen: o.now,
  };
  if (at >= 0) alive.splice(at, 1);
  alive.push(member);
  while (alive.length > Math.max(1, o.max)) alive.shift(); // the one that joined earliest loses its slot
  return { members: alive, changed: true, member };
}

/** What a client is told: the roster without the bookkeeping. */
export const publicMembers = (members: PresenceMember[]) => members.map((m) => ({ id: m.id, name: m.name, color: m.color, x: m.x, y: m.y }));

const flag = (name: string, fallback: string): string => {
  try { return String((runtimeEnv as Record<string, unknown>)[name] ?? process.env?.[name] ?? fallback); } catch { return fallback; }
};

/** Presence is off unless the instance asks for it: it is an anonymous, public fanout. */
export const presenceEnabled = (): boolean => ["1", "true", "on", "yes"].includes(flag("VOIDBASE_PRESENCE", "0").trim().toLowerCase());
/** How many hold a slot at once (the page's "last three"). */
export const presenceMax = (): number => Math.min(12, Math.max(1, Number(flag("VOIDBASE_PRESENCE_MAX", "3")) || 3));
/** How long a slot survives without a beat. */
export const presenceTtlMs = (): number => Math.min(120_000, Math.max(2_000, (Number(flag("VOIDBASE_PRESENCE_TTL", "12")) || 12) * 1000));
