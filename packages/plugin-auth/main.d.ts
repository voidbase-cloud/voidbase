import type { Auth } from "@voidbase-cloud/voidbase/interfaces";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
export declare const provider: Auth;
declare const auth: Omit<Plugin, "manifest">;
export default auth;
