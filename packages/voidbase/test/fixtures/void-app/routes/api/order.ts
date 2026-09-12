import { defineHandler } from "void";

export const GET = defineHandler((c) => ({ middleware: c.get("mwOrder") ?? [] }));
