// What the core gets when nothing provides realtime@1.
//
// The kernel's `using()` answers with the interface or with undefined, so the slots that ask it per request guard
// the answer: no hardening provider means no policy (`?? next()`), no observability provider means nothing sampled.
// Realtime was the one that did not, and it is on every request: `using(kernel, "realtime@1").for(c.env)` threw
// for an instance whose realtime plugin is disabled in voidbase.lock, or replaced by a plugin that does not provide
// the interface. A client that says realtime is off is the same answer every caller already handles, because a hub
// is a deployment detail and the Bun runtime has none: `active()` is asked first, and a change falls back to the D1
// change feed. This is not hub-client.ts's `NoHub`, which belongs to the realtime plugin and means "no hub bound";
// this means "no realtime plugin", and the core cannot import a plugin to say so.
import type { Realtime, RealtimeClient } from "./interfaces";
import type { Bindings } from "./types";

/** realtime with nobody to fan a change out to: every caller asks `active()` first and falls back to the change feed */
export const realtimeOff: RealtimeClient = {
  active: () => false,
  publish: async () => {},
  presence: async () => null,
  publishToClient: async () => false,
  controlClient: async () => {},
  openSocket: () => Promise.reject(new Error("voidbase: no plugin provides realtime@1 on this instance, so there is no socket to open")),
};

/** the realtime client for this request's bindings, or one that says realtime is off when nothing provides it */
export const realtimeOf = (provider: Realtime | undefined, env: Bindings): RealtimeClient => provider?.for(env) ?? realtimeOff;
