import type { Collection } from "./collections/model";

export type Row = Record<string, unknown>;

export interface AuthRecord {
  collection: Collection;
  row: Row;
}

export interface Bindings {
  DB: D1Database;
}

export interface Variables {
  auth: AuthRecord | null;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
