declare module "virtual:voidbase-migrations" {
  export const migrationsDir: string;
  export const migrations: { name: string; run: (g: Record<string, unknown>) => Promise<void> }[];
}
