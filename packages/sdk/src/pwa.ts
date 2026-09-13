// The service worker side of a voidbase PWA: @voidbase-cloud/sdk/pwa
//
// The voidbase adapter's `pwa` option serves a manifest.webmanifest and a
// sw.js at the site root. This entry registers that worker from the page
// and speaks its message protocol:
//
// - the worker never skips waiting by itself; the page posts
//   `{ type: "SKIP_WAITING" }` to the waiting worker to make it call
//   skipWaiting(),
// - on activate the new worker posts `{ type: "UPDATED", version }` to
//   every client,
// - `{ type: "UNREGISTER" }` makes the worker unregister itself and clear
//   its caches.
//
// Everything here is a no-op where there is no window or no service worker
// support (server-side rendering, old browsers): registerServiceWorker()
// answers null and installPrompt() answers "unavailable". The entry imports
// only types from the core package, so it carries no second copy of the
// client.

import type Client from "@voidbase-cloud/sdk";
import type { Plugin } from "@voidbase-cloud/sdk";

export interface PwaOptions {
    /**
     * The url of the service worker script (default: "/sw.js").
     */
    url?: string;

    /**
     * The scope to register the worker under (default: the browser's, the
     * directory of the script).
     */
    scope?: string;

    /**
     * Called when a new worker is installed while an older one controls the
     * page; `apply()` posts SKIP_WAITING to the new worker and reloads the
     * page once it takes over. Without it (and without `immediate`) the new
     * worker waits until every tab of the site is closed.
     */
    onUpdate?: (apply: () => void) => void;

    /**
     * Called with the version the new worker reports once it has taken over.
     */
    onUpdated?: (version: string) => void;

    /**
     * Apply an update as soon as it is installed instead of asking through
     * `onUpdate` (default: false).
     */
    immediate?: boolean;
}

/**
 * What `registerServiceWorker()` answers when service workers are supported.
 */
export interface PwaRegistration {
    /**
     * The browser's registration.
     */
    registration: ServiceWorkerRegistration;

    /**
     * Asks the browser to check the script for a new version now.
     */
    update(): Promise<void>;

    /**
     * Posts UNREGISTER to the worker (so it clears its caches) and
     * unregisters it; answers what the browser answered.
     */
    unregister(): Promise<boolean>;

    /**
     * The version the worker last reported through an UPDATED message,
     * null until one arrives.
     */
    version: string | null;
}

/**
 * The install prompt of the page, from the `beforeinstallprompt` event.
 */
export interface InstallPrompt {
    /**
     * Whether the browser has offered the prompt and it was not used yet.
     */
    readonly available: boolean;

    /**
     * Shows the prompt; answers what the user chose, or "unavailable" when
     * the browser has not offered one (or it was used already).
     */
    prompt(): Promise<"accepted" | "dismissed" | "unavailable">;

    /**
     * Calls back when the prompt becomes available (at once when it already
     * is); answers the remover.
     */
    onAvailable(cb: () => void): () => void;
}

/**
 * A client with the pwa plugin installed (what `client.use(pwa())` answers).
 */
export type PwaClient<T extends Client = Client> = T & {
    pwa: Promise<PwaRegistration | null>;
};

interface UpdatedMessage {
    type: "UPDATED";
    version?: string;
}

function hasServiceWorker(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof navigator !== "undefined" &&
        !!navigator &&
        !!(navigator as any).serviceWorker &&
        typeof (navigator as any).serviceWorker.register === "function"
    );
}

function whenLoaded(): Promise<void> {
    if (typeof document === "undefined" || document.readyState === "complete") {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        window.addEventListener("load", () => resolve(), { once: true });
    });
}

/**
 * Registers the service worker after the page has loaded and keeps track of
 * its updates.
 *
 * ```js
 * import { registerServiceWorker } from "@voidbase-cloud/sdk/pwa";
 *
 * const sw = await registerServiceWorker({
 *     onUpdate: (apply) => {
 *         if (confirm("A new version is ready. Reload?")) apply();
 *     },
 *     onUpdated: (version) => console.log("now on", version),
 * });
 * ```
 *
 * Answers null, without throwing, when service workers are unsupported or
 * there is no window (server-side).
 */
export async function registerServiceWorker(
    options: PwaOptions = {},
): Promise<PwaRegistration | null> {
    if (!hasServiceWorker()) {
        return null;
    }

    const sw = navigator.serviceWorker;

    await whenLoaded();

    const registration = await sw.register(
        options.url || "/sw.js",
        options.scope ? { scope: options.scope } : undefined,
    );

    const result: PwaRegistration = {
        registration,
        version: null,
        update: async () => {
            await registration.update();
        },
        unregister: async () => {
            const worker =
                registration.active || registration.waiting || registration.installing;
            worker?.postMessage({ type: "UNREGISTER" });
            sw.removeEventListener("message", onMessage);
            sw.removeEventListener("controllerchange", onControllerChange);
            return registration.unregister();
        },
    };

    // apply(): let the waiting worker take over and reload once it has
    let applying = false;
    let reloaded = false;
    const onControllerChange = () => {
        if (!applying || reloaded) {
            return;
        }
        reloaded = true;
        window.location.reload();
    };
    sw.addEventListener("controllerchange", onControllerChange);

    // the worker installed and waiting to take over, once there is one
    let installed: ServiceWorker | null = null;
    const apply = () => {
        const waiting = registration.waiting || installed;
        if (!waiting) {
            return;
        }
        applying = true;
        waiting.postMessage({ type: "SKIP_WAITING" });
    };

    const offerUpdate = (worker: ServiceWorker) => {
        installed = worker;
        if (options.immediate) {
            apply();
        } else if (options.onUpdate) {
            options.onUpdate(apply);
        }
    };

    // a new worker installed while another controls the page is an update
    const track = (worker: ServiceWorker) => {
        worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && sw.controller) {
                offerUpdate(worker);
            }
        });
    };
    registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (worker) {
            track(worker);
        }
    });
    if (registration.waiting && sw.controller) {
        // it was installed on an earlier visit and is still waiting
        offerUpdate(registration.waiting);
    }

    const onMessage = (e: MessageEvent<UpdatedMessage | any>) => {
        const data = e.data;
        if (data && typeof data === "object" && data.type === "UPDATED") {
            const version = typeof data.version === "string" ? data.version : "";
            result.version = version;
            options.onUpdated?.(version);
        }
    };
    sw.addEventListener("message", onMessage);

    return result;
}

let deferredPrompt: any = null;
let promptListeners: Set<() => void> | null = null;

function captureInstallPrompt(): void {
    if (promptListeners || typeof window === "undefined" || !window.addEventListener) {
        return;
    }

    promptListeners = new Set();

    window.addEventListener("beforeinstallprompt", (e: Event) => {
        e.preventDefault();
        deferredPrompt = e;
        for (const cb of Array.from(promptListeners!)) {
            cb();
        }
    });

    window.addEventListener("appinstalled", () => {
        deferredPrompt = null;
    });
}

/**
 * Captures the browser's `beforeinstallprompt` event so that the page can
 * show the install prompt from its own button. Call it early (at module
 * load) so that the event is not missed.
 *
 * ```js
 * import { installPrompt } from "@voidbase-cloud/sdk/pwa";
 *
 * const install = installPrompt();
 * install.onAvailable(() => button.hidden = false);
 * button.onclick = async () => console.log(await install.prompt()); // "accepted" | "dismissed"
 * ```
 */
export function installPrompt(): InstallPrompt {
    captureInstallPrompt();

    return {
        get available() {
            return !!deferredPrompt;
        },
        async prompt() {
            const e = deferredPrompt;
            if (!e) {
                return "unavailable";
            }
            deferredPrompt = null;
            e.prompt();
            const choice = await e.userChoice;
            return choice?.outcome === "accepted" ? "accepted" : "dismissed";
        },
        onAvailable(cb: () => void) {
            if (deferredPrompt) {
                cb();
            }
            promptListeners?.add(cb);
            return () => {
                promptListeners?.delete(cb);
            };
        },
    };
}

/**
 * The pwa plugin: registers the service worker at install and attaches the
 * pending registration as `client.pwa`.
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { pwa } from "@voidbase-cloud/sdk/pwa";
 *
 * const pb = new PocketBase("https://example.com").use(pwa({ onUpdate: (apply) => apply() }));
 *
 * const sw = await pb.pwa; // PwaRegistration, or null where unsupported
 * ```
 *
 * `client.unuse("pwa")` removes `client.pwa`; it does not unregister the
 * worker (call `(await client.pwa)?.unregister()` for that).
 */
export function pwa(
    options: PwaOptions = {},
): Plugin<{ pwa: Promise<PwaRegistration | null> }> {
    return {
        name: "pwa",
        install(client: Client) {
            const ready = registerServiceWorker(options);
            // an unhandled rejection is the app's to observe through client.pwa
            ready.catch(() => {});
            (client as PwaClient).pwa = ready;

            return () => {
                delete (client as any).pwa;
            };
        },
    };
}
