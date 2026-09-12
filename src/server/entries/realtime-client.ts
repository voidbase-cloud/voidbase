// `@voidbase-cloud/voidbase/realtime-client`: the client the realtime plugin provides, for that plugin.
//
// plugins/realtime.ts provides `realtime@1` as one call — `realtimeFor(env)`, the hub client for this request's
// bindings, or the one that says realtime is off when the instance has no HUB. The classes behind it (`HubClient`,
// `NoHub`) and the wire protocol they speak to the Durable Object (`HubMessage`, `sendFilter`) stay unpublished in
// ../realtime/hub-client.ts: they are what the core's own realtime routes talk to the hub with, and a plugin that
// wants a client asks for one here rather than constructing it.
export { realtimeFor } from "../realtime/hub-client";
