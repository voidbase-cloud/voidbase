// The names the deploy and the ai plugin agree on: data, so src/node/deploy-cf.ts can write the binding without
// importing what the plugin does (the kernel, the MCP tool list, the platform modules).
/** the Workers AI binding the deploy adds to the Worker when VOIDBASE_AI is set */
export const AI_BINDING = "AI";
/** the knob: `1` for the default model, or a Workers AI model name; baked as a var beside the binding */
export const AI_VAR = "VOIDBASE_AI";
/** the model the knob's `1` means, and the one the route uses when the request names none */
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** the model a knob value means: `1`, `true`, `on`, `yes` mean the default, a model name means itself, off means "" */
export function aiModelOf(value: string | undefined): string {
  const v = String(value ?? "").trim();
  if (!v || /^(0|false|off|no)$/i.test(v)) return "";
  if (/^(1|true|on|yes)$/i.test(v)) return DEFAULT_MODEL;
  return v;
}
