// Installed plugins on Workers: pb_plugins bundled at build time by hooks-plugin.ts (virtual module), each bundle
// checked against voidbase.lock before it is bundled, so a mismatch fails the build rather than the instance.
export { disabled, installed } from "virtual:voidbase-plugins";
