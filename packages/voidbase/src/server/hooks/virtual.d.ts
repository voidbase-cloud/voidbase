declare module "virtual:voidbase-hooks" {
  export const hooksDir: string;
  export const asyncNames: string[];
  export const hooks: { name: string; run: (g: Record<string, unknown>) => Promise<void> }[];
  export const modules: Record<string, (g: Record<string, unknown>) => Promise<unknown>>;
  export const files: Record<string, string>;
}
