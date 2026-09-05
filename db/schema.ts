// System tables only. User collections are created at runtime from _collections rows (schema is data, as in PocketBase).
// This file exists so `void db generate` produces the bootstrap migration that `void deploy` applies.
import { index, integer, sqliteTable, text, uniqueIndex } from "void/schema-d1";
import { sql } from "void/db";

const now = sql`(strftime('%Y-%m-%d %H:%M:%fZ'))`;
const randomId = sql`('r'||lower(hex(randomblob(7))))`;

export const collections = sqliteTable(
  "_collections",
  {
    id: text("id").primaryKey().notNull().default(randomId),
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    type: text("type").notNull().default("base"),
    name: text("name").notNull().unique(),
    fields: text("fields").notNull().default("[]"),
    indexes: text("indexes").notNull().default("[]"),
    listRule: text("listRule"),
    viewRule: text("viewRule"),
    createRule: text("createRule"),
    updateRule: text("updateRule"),
    deleteRule: text("deleteRule"),
    options: text("options").notNull().default("{}"),
    created: text("created").notNull().default(now),
    updated: text("updated").notNull().default(now),
  },
  (t) => [index("idx__collections_type").on(t.type)],
);

export const params = sqliteTable("_params", {
  id: text("id").primaryKey().notNull().default(randomId),
  value: text("value"),
  created: text("created").notNull().default(now),
  updated: text("updated").notNull().default(now),
});

// PocketBase-style JS migrations (pb_migrations) applied by the hooks runtime. Named _pbMigrations because Void keeps its own _migrations table.
export const migrations = sqliteTable("_pbMigrations", {
  file: text("file").primaryKey().notNull(),
  applied: integer("applied").notNull(),
});

// System auth collection: superusers (collection id pbc_3142635823 in PocketBase).
export const superusers = sqliteTable(
  "_superusers",
  {
    id: text("id").primaryKey().notNull().default(randomId),
    password: text("password").notNull().default(""),
    tokenKey: text("tokenKey").notNull().default(""),
    email: text("email").notNull().default(""),
    emailVisibility: integer("emailVisibility", { mode: "boolean" }).notNull().default(false),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    created: text("created").notNull().default(""),
    updated: text("updated").notNull().default(""),
  },
  (t) => [
    uniqueIndex("idx_tokenKey_pbc_3142635823").on(t.tokenKey),
    uniqueIndex("idx_email_pbc_3142635823").on(t.email).where(sql`${t.email} != ''`),
  ],
);

const refCols = {
  id: text("id").primaryKey().notNull().default(randomId),
  collectionRef: text("collectionRef").notNull().default(""),
  recordRef: text("recordRef").notNull().default(""),
  created: text("created").notNull().default(""),
  updated: text("updated").notNull().default(""),
};

export const mfas = sqliteTable("_mfas", { ...refCols, method: text("method").notNull().default("") }, (t) => [
  index("idx_mfas_collectionRef_recordRef").on(t.collectionRef, t.recordRef),
]);

export const otps = sqliteTable(
  "_otps",
  { ...refCols, password: text("password").notNull().default(""), sentTo: text("sentTo").notNull().default("") },
  (t) => [index("idx_otps_collectionRef_recordRef").on(t.collectionRef, t.recordRef)],
);

export const externalAuths = sqliteTable(
  "_externalAuths",
  { ...refCols, provider: text("provider").notNull().default(""), providerId: text("providerId").notNull().default("") },
  (t) => [
    uniqueIndex("idx_externalAuths_record_provider").on(t.collectionRef, t.recordRef, t.provider),
    uniqueIndex("idx_externalAuths_collection_provider").on(t.collectionRef, t.provider, t.providerId),
  ],
);

export const authOrigins = sqliteTable(
  "_authOrigins",
  { ...refCols, fingerprint: text("fingerprint").notNull().default("") },
  (t) => [uniqueIndex("idx_authOrigins_unique_pairs").on(t.collectionRef, t.recordRef, t.fingerprint)],
);

// Realtime change feed (decision d5): appended inside the record write batch, polled by open SSE streams.
export const changes = sqliteTable(
  "_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    collection: text("collection").notNull(),
    recordId: text("recordId").notNull(),
    action: text("action").notNull(), // create | update | delete
    data: text("data"), // record JSON at the time of the change (deletes cannot be re-read)
    created: text("created").notNull().default(now),
  },
  (t) => [index("idx__changes_collection").on(t.collection, t.id)],
);

// Connected SSE clients and their subscriptions (the POST can land on any isolate).
export const realtimeClients = sqliteTable("_realtime_clients", {
  id: text("id").primaryKey().notNull(),
  subscriptions: text("subscriptions").notNull().default("[]"),
  token: text("token").notNull().default(""),
  created: text("created").notNull().default(now),
  updated: text("updated").notNull().default(now),
});
