import { describe, assert, test, beforeEach, afterEach, vi } from "vitest";
import Client from "@/Client";
import { registerServiceWorker, installPrompt, pwa } from "@/pwa";

type Listener = (e: any) => void;

class Emitter {
    listeners = new Map<string, Set<Listener>>();

    addEventListener(type: string, fn: Listener) {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(fn);
    }

    removeEventListener(type: string, fn: Listener) {
        this.listeners.get(type)?.delete(fn);
    }

    emit(type: string, e: any = {}) {
        for (const fn of Array.from(this.listeners.get(type) || [])) {
            fn(e);
        }
    }
}

/**
 * A worker that records what is posted to it and walks the install
 * states when told to.
 */
class FakeWorker extends Emitter {
    state = "installing";
    posted: Array<any> = [];

    postMessage(msg: any) {
        this.posted.push(msg);
    }

    become(state: string) {
        this.state = state;
        this.emit("statechange");
    }
}

class FakeRegistration extends Emitter {
    installing: FakeWorker | null = null;
    waiting: FakeWorker | null = null;
    active: FakeWorker | null = null;
    updates = 0;
    unregistered = false;

    async update() {
        this.updates++;
    }

    async unregister() {
        this.unregistered = true;
        return true;
    }

    /**
     * A new script was found: a worker installs and, once installed, waits.
     */
    findUpdate(): FakeWorker {
        const worker = new FakeWorker();
        this.installing = worker;
        this.emit("updatefound");
        // the browser moves it to waiting before the statechange fires
        this.installing = null;
        this.waiting = worker;
        worker.become("installed");
        return worker;
    }

    /**
     * The waiting worker takes over (what skipWaiting() leads to).
     */
    activate(container: FakeContainer, version: string) {
        const worker = this.waiting!;
        this.waiting = null;
        this.active = worker;
        worker.become("activated");
        container.controller = worker;
        container.emit("controllerchange");
        container.emit("message", { data: { type: "UPDATED", version } });
    }
}

/**
 * navigator.serviceWorker
 */
class FakeContainer extends Emitter {
    controller: FakeWorker | null = null;
    registration = new FakeRegistration();
    registered: Array<{ url: string; options: any }> = [];

    async register(url: string, options?: any) {
        this.registered.push({ url, options });
        return this.registration;
    }
}

describe("pwa", function () {
    let container: FakeContainer;
    let reload: ReturnType<typeof vi.fn>;
    let win: Emitter & { location: { reload: any } };

    beforeEach(function () {
        container = new FakeContainer();
        reload = vi.fn();
        win = Object.assign(new Emitter(), { location: { reload } });
        vi.stubGlobal("window", win);
        vi.stubGlobal("document", { readyState: "complete" });
        vi.stubGlobal("navigator", { serviceWorker: container });
    });

    afterEach(function () {
        vi.unstubAllGlobals();
    });

    describe("registerServiceWorker()", function () {
        test("Should answer null where there is no window", async function () {
            vi.stubGlobal("window", undefined);
            assert.isNull(await registerServiceWorker());
        });

        test("Should answer null where service workers are unsupported", async function () {
            vi.stubGlobal("navigator", {});
            assert.isNull(await registerServiceWorker());
        });

        test("Should register /sw.js once the page is loaded", async function () {
            vi.stubGlobal("document", { readyState: "loading" });

            const pending = registerServiceWorker();
            await Promise.resolve();
            assert.lengthOf(container.registered, 0);

            win.emit("load");
            const sw = await pending;

            assert.isNotNull(sw);
            assert.deepEqual(container.registered, [
                { url: "/sw.js", options: undefined },
            ]);
            assert.strictEqual(sw!.registration, container.registration as any);
            assert.isNull(sw!.version);

            await sw!.update();
            assert.equal(container.registration.updates, 1);
        });

        test("Should register at once when the page is already loaded, with url and scope", async function () {
            await registerServiceWorker({ url: "/worker.js", scope: "/app/" });

            assert.deepEqual(container.registered, [
                { url: "/worker.js", options: { scope: "/app/" } },
            ]);
        });

        test("Should offer an update whose apply posts SKIP_WAITING and reloads once", async function () {
            // an older worker controls the page
            container.controller = new FakeWorker();

            let apply: (() => void) | null = null;
            const updated: Array<string> = [];
            const sw = await registerServiceWorker({
                onUpdate: (fn) => {
                    apply = fn;
                },
                onUpdated: (v) => updated.push(v),
            });

            const worker = container.registration.findUpdate();
            assert.isFunction(apply);
            assert.deepEqual(worker.posted, []); // nothing is skipped without consent

            apply!();
            assert.deepEqual(worker.posted, [{ type: "SKIP_WAITING" }]);
            assert.equal(reload.mock.calls.length, 0);

            container.registration.activate(container, "2");
            assert.equal(reload.mock.calls.length, 1);
            assert.deepEqual(updated, ["2"]);
            assert.equal(sw!.version, "2");

            // a second controllerchange does not reload again
            container.emit("controllerchange");
            assert.equal(reload.mock.calls.length, 1);
        });

        test("Should not offer the first install as an update", async function () {
            let offered = 0;
            await registerServiceWorker({ onUpdate: () => offered++ });

            // no controller yet: this is the first worker of the site
            container.registration.findUpdate();
            assert.equal(offered, 0);

            container.registration.activate(container, "1");
            assert.equal(reload.mock.calls.length, 0);
        });

        test("Should apply at once in immediate mode", async function () {
            container.controller = new FakeWorker();
            let offered = 0;
            await registerServiceWorker({ immediate: true, onUpdate: () => offered++ });

            const worker = container.registration.findUpdate();
            assert.equal(offered, 0);
            assert.deepEqual(worker.posted, [{ type: "SKIP_WAITING" }]);

            container.registration.activate(container, "3");
            assert.equal(reload.mock.calls.length, 1);
        });

        test("Should offer a worker already waiting at registration", async function () {
            container.controller = new FakeWorker();
            const waiting = new FakeWorker();
            waiting.state = "installed";
            container.registration.waiting = waiting;

            let apply: (() => void) | null = null;
            await registerServiceWorker({ onUpdate: (fn) => (apply = fn) });

            assert.isFunction(apply);
            apply!();
            assert.deepEqual(waiting.posted, [{ type: "SKIP_WAITING" }]);
        });

        test("Should deliver UPDATED messages", async function () {
            const updated: Array<string> = [];
            const sw = await registerServiceWorker({ onUpdated: (v) => updated.push(v) });

            container.emit("message", { data: { type: "UPDATED", version: "abc" } });
            container.emit("message", { data: { type: "OTHER" } });
            container.emit("message", { data: "text" });

            assert.deepEqual(updated, ["abc"]);
            assert.equal(sw!.version, "abc");
        });

        test("Should post UNREGISTER to the worker and unregister", async function () {
            const active = new FakeWorker();
            active.state = "activated";
            container.registration.active = active;
            const updated: Array<string> = [];

            const sw = await registerServiceWorker({ onUpdated: (v) => updated.push(v) });
            assert.isTrue(await sw!.unregister());

            assert.deepEqual(active.posted, [{ type: "UNREGISTER" }]);
            assert.isTrue(container.registration.unregistered);

            // it stopped listening
            container.emit("message", { data: { type: "UPDATED", version: "x" } });
            assert.deepEqual(updated, []);
        });
    });

    describe("installPrompt()", function () {
        test("Should answer unavailable without a window", async function () {
            vi.stubGlobal("window", undefined);
            const install = installPrompt();

            assert.isFalse(install.available);
            assert.equal(await install.prompt(), "unavailable");
            assert.isFunction(install.onAvailable(() => {}));
        });

        test("Should capture beforeinstallprompt and show it on demand", async function () {
            const install = installPrompt();
            let available = 0;
            const off = install.onAvailable(() => available++);

            assert.isFalse(install.available);
            assert.equal(await install.prompt(), "unavailable");

            let prevented = false;
            let shown = 0;
            win.emit("beforeinstallprompt", {
                preventDefault: () => (prevented = true),
                prompt: () => shown++,
                userChoice: Promise.resolve({ outcome: "accepted" }),
            });

            assert.isTrue(prevented);
            assert.isTrue(install.available);
            assert.equal(available, 1);

            // already available: the callback fires at once
            install.onAvailable(() => available++);
            assert.equal(available, 2);

            assert.equal(await install.prompt(), "accepted");
            assert.equal(shown, 1);
            assert.isFalse(install.available); // a prompt can be shown once
            assert.equal(await install.prompt(), "unavailable");

            off();
            win.emit("beforeinstallprompt", {
                preventDefault() {},
                prompt() {},
                userChoice: Promise.resolve({ outcome: "dismissed" }),
            });
            assert.equal(available, 3); // only the second callback is left
            assert.equal(await install.prompt(), "dismissed");
        });
    });

    describe("pwa()", function () {
        test("Should install as a plugin and attach client.pwa", async function () {
            const pb = new Client("http://test").use(pwa({ url: "/custom.js" }));

            assert.deepEqual(pb.plugins, ["pwa"]);
            const sw = await pb.pwa;
            assert.isNotNull(sw);
            assert.equal(container.registered[0].url, "/custom.js");

            pb.unuse("pwa");
            assert.isUndefined((pb as any).pwa);
        });

        test("Should attach null where unsupported", async function () {
            vi.stubGlobal("navigator", {});
            const pb = new Client("http://test").use(pwa());

            assert.isNull(await pb.pwa);
        });
    });
});
