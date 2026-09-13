declare module "virtual:voidbase-hooks" {
  /** the routes the hook files add, with what each answers where the source says (hooks-plugin.ts routeDocsOf) */
  export const routeDocs: { method: string; path: string; superuser: boolean; response?: Record<string, unknown> }[];
  export const hooksDir: string;
  export const asyncNames: string[];
  export const hooks: { name: string; run: (g: Record<string, unknown>) => Promise<void> }[];
  export const modules: Record<string, (g: Record<string, unknown>) => Promise<unknown>>;
  export const files: Record<string, string>;
}
