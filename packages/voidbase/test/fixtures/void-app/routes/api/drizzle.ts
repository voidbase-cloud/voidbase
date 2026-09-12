import { defineHandler } from "void";
import { db } from "void/db";
import { outbox } from "@schema";

// void/db is a tsconfig path to a declaration file; under voidbase the adapter's shim makes it resolve at runtime
export const GET = defineHandler(async () => ({ rows: (await db.select().from(outbox)).length }));
