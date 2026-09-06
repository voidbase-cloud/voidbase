import { defineHandler } from "void";

// a literal segment must win over the sibling [id] route
export const GET = defineHandler(() => ({ id: "me", literal: true }));
