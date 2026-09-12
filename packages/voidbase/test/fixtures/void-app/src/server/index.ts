// A plain module under src/, reached through the tsconfig alias `@/server` -- a directory, so the bundler has to
// find its index file. The middleware/ hooks import it.
export const state = { boots: 0, requests: 0, lists: 0 };
