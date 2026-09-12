import { defineHandler } from "void";

export const GET = defineHandler(() => ({ message: "hello", from: "void" }));
