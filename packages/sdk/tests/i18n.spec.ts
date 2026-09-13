// @vitest-environment jsdom

import { describe, assert, test, beforeEach, afterEach, vi } from "vitest";
import Client from "@/Client";
import { i18n, Catalogues } from "@/i18n";

interface Call {
    url: string;
    method: string;
    headers: { [key: string]: string };
}

/**
 * A fetch that records every call and answers each with a 200.
 */
class NetworkMock {
    calls: Array<Call> = [];
    private originalFetch?: typeof fetch;

    init() {
        this.originalFetch = global.fetch;
        global.fetch = async (url: any, config: any) => {
            this.calls.push({
                url: String(url),
                method: config?.method || "GET",
                headers: config?.headers || {},
            });

            return {
                url: String(url),
                status: 200,
                json: async () => ({ ok: true }),
            } as Response;
        };
    }

    restore() {
        global.fetch = this.originalFetch!;
    }
}

class FakeStorage {
    data = new Map<string, string>();
    getItem(key: string) {
        return this.data.has(key) ? this.data.get(key)! : null;
    }
    setItem(key: string, value: string) {
        this.data.set(key, value);
    }
    removeItem(key: string) {
        this.data.delete(key);
    }
}

// what `voidbase i18n extract` writes: a flat key-to-text object per locale,
// the first being the source one, "" meaning untranslated
const en = {
    greeting: "Hello",
    hello: "Hello, {name}",
    "nav.home": "Home",
    cart: "{count} items",
};
const ar = {
    greeting: "مرحبا",
    hello: "مرحبا يا {name}",
    "nav.home": "",
    cart: "",
};
const fr = {
    greeting: "Bonjour",
    hello: "",
    "nav.home": "Accueil",
    cart: "",
};

const CATALOGUES: Catalogues = { en, ar, fr };

describe("i18n()", function () {
    const net = new NetworkMock();
    let pb: Client;

    beforeEach(function () {
        net.init();
        net.calls = [];
        pb = new Client("http://test");
    });

    afterEach(function () {
        pb.unuse("i18n");
        net.restore();
        vi.unstubAllGlobals();
    });

    test("Should install as a plugin, attach client.i18n and remove it and its hook on uninstall", function () {
        assert.equal(pb.hooks.beforeSend.size, 0);

        const client = pb.use(i18n({ catalogues: CATALOGUES }));

        assert.deepEqual(client.plugins, ["i18n"]);
        assert.deepEqual(client.i18n.locales, ["en", "ar", "fr"]);
        assert.isFunction(client.i18n.t);
        assert.isFunction(client.i18n.has);
        assert.isFunction(client.i18n.setLocale);
        assert.isFunction(client.i18n.onChange);
        assert.isFunction(client.i18n.missing);
        assert.equal(pb.hooks.beforeSend.size, 1);

        client.unuse("i18n");
        assert.isUndefined((client as any).i18n);
        assert.equal(pb.hooks.beforeSend.size, 0);
    });

    describe("the locale", function () {
        test("Should negotiate from navigator and take the explicit option over it", function () {
            vi.stubGlobal("navigator", { language: "fr-FR", languages: ["fr-FR", "fr"] });

            // by primary subtag, "fr-FR" finding the "fr" catalogue
            const guessed = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES }),
            );
            assert.equal(guessed.i18n.locale, "fr");

            const asked = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES, locale: "ar" }),
            );
            assert.equal(asked.i18n.locale, "ar");

            // a code no catalogue answers to is kept as given and falls back
            const unknown = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES, locale: "de" }),
            );
            assert.equal(unknown.i18n.locale, "de");
            assert.equal(unknown.i18n.t("greeting"), "Hello");

            // nothing the browser prefers: the first catalogue, the source locale
            vi.stubGlobal("navigator", { language: "ja", languages: ["ja"] });
            const source = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES }),
            );
            assert.equal(source.i18n.locale, "en");

            // and with no navigator at all (the server)
            vi.stubGlobal("navigator", undefined);
            const none = new Client("http://test").use(i18n({ catalogues: { ar, en } }));
            assert.equal(none.i18n.locale, "ar");
        });

        test("Should change it, tell onChange and persist the choice", function () {
            const store = new FakeStorage();
            vi.stubGlobal("localStorage", store);

            const client = pb.use(i18n({ catalogues: CATALOGUES, persist: true }));
            const seen: Array<string> = [];
            const stop = client.i18n.onChange((locale) => seen.push(locale));

            assert.equal(client.i18n.locale, "en"); // jsdom says en-US
            client.i18n.setLocale("ar");
            assert.equal(client.i18n.locale, "ar");
            assert.equal(client.i18n.t("greeting"), "مرحبا");
            assert.deepEqual(seen, ["ar"]);
            assert.equal(store.getItem("voidbase_locale"), "ar");

            // the same locale again is not a change
            client.i18n.setLocale("ar");
            assert.deepEqual(seen, ["ar"]);

            // a region subtag finds the catalogue
            client.i18n.setLocale("fr-CA");
            assert.equal(client.i18n.locale, "fr");
            assert.deepEqual(seen, ["ar", "fr"]);

            // the listener can be stopped
            stop();
            client.i18n.setLocale("en");
            assert.deepEqual(seen, ["ar", "fr"]);
            assert.equal(store.getItem("voidbase_locale"), "en");

            // a later client picks the persisted choice up, over what the
            // browser prefers, and an explicit locale still wins over both
            store.setItem("voidbase_locale", "ar");
            const remembered = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES, persist: true }),
            );
            assert.equal(remembered.i18n.locale, "ar");
            const forced = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES, persist: true, locale: "fr" }),
            );
            assert.equal(forced.i18n.locale, "fr");

            // under the key given, and nothing at all without the option
            store.setItem("app_locale", "fr");
            const keyed = new Client("http://test").use(
                i18n({ catalogues: CATALOGUES, persist: "app_locale" }),
            );
            assert.equal(keyed.i18n.locale, "fr");
            keyed.i18n.setLocale("ar");
            assert.equal(store.getItem("app_locale"), "ar");

            store.data.clear();
            const plain = new Client("http://test").use(i18n({ catalogues: CATALOGUES }));
            plain.i18n.setLocale("fr");
            assert.equal(plain.i18n.locale, "fr");
            assert.equal(store.data.size, 0);
        });
    });

    describe("t()", function () {
        test("Should answer the text of the key, with the vars filled in", function () {
            const client = pb.use(i18n({ catalogues: CATALOGUES }));

            assert.equal(client.i18n.t("greeting"), "Hello");
            assert.equal(client.i18n.t("nav.home"), "Home");
            assert.equal(client.i18n.t("hello", { name: "Ada" }), "Hello, Ada");
            assert.equal(client.i18n.t("cart", { count: 3 }), "3 items");

            // a placeholder without a value is left alone
            assert.equal(client.i18n.t("hello"), "Hello, {name}");
            assert.equal(client.i18n.t("hello", {}), "Hello, {name}");
            assert.equal(client.i18n.t("hello", { name: undefined }), "Hello, {name}");

            // and t is bound to the controller
            const { t } = client.i18n;
            assert.equal(t("greeting"), "Hello");
        });

        test("Should interpolate with the delimiters given", function () {
            const client = pb.use(
                i18n({
                    catalogues: { en: { hi: "Hi [[name]]" } },
                    vars: { open: "[[", close: "]]" },
                }),
            );

            assert.equal(client.i18n.t("hi", { name: "Ada" }), "Hi Ada");
            assert.equal(client.i18n.t("hi"), "Hi [[name]]");
        });

        test("Should fall through an empty string to the source locale and then to the key", function () {
            const client = pb.use(i18n({ catalogues: CATALOGUES, locale: "ar" }));

            assert.equal(client.i18n.t("greeting"), "مرحبا");
            assert.equal(client.i18n.t("hello", { name: "Ada" }), "مرحبا يا Ada");
            // "" in ar: the source locale's text, filled in the same way
            assert.equal(client.i18n.t("nav.home"), "Home");
            assert.equal(client.i18n.t("cart", { count: 2 }), "2 items");
            // and a key no catalogue knows answers itself
            assert.equal(client.i18n.t("nope"), "nope");

            assert.isTrue(client.i18n.has("greeting"));
            assert.isTrue(client.i18n.has("nav.home"));
            assert.isFalse(client.i18n.has("nope"));

            client.unuse("i18n");

            // with fallback "key" an empty string is the key straight away
            const keyed = pb.use(
                i18n({ catalogues: CATALOGUES, locale: "ar", fallback: "key" }),
            );
            assert.equal(keyed.i18n.t("greeting"), "مرحبا");
            assert.equal(keyed.i18n.t("nav.home"), "nav.home");
            assert.isFalse(keyed.i18n.has("nav.home"));
            assert.deepEqual(keyed.i18n.missing(), ["nav.home"]);
        });

        test("Should record a key that answered itself and tell onMissing", function () {
            const seen: Array<Array<string>> = [];
            const client = pb.use(
                i18n({
                    catalogues: CATALOGUES,
                    locale: "ar",
                    onMissing: (key, locale) => seen.push([key, locale]),
                }),
            );

            assert.deepEqual(client.i18n.missing(), []);

            client.i18n.t("nope");
            client.i18n.t("nope");
            client.i18n.t("other");
            client.i18n.t("greeting");
            client.i18n.t("nav.home"); // answered by the source locale

            // once each, in the order they were first asked for
            assert.deepEqual(client.i18n.missing(), ["nope", "other"]);
            // but onMissing hears about every call
            assert.deepEqual(seen, [
                ["nope", "ar"],
                ["nope", "ar"],
                ["other", "ar"],
            ]);
        });
    });

    test("Should send the locale as Accept-Language with every request", async function () {
        const client = pb.use(i18n({ catalogues: CATALOGUES }));

        await client.send("/api/hello", { method: "GET" });
        assert.lengthOf(net.calls, 1);
        assert.equal(net.calls[0].headers["Accept-Language"], "en");

        // the header follows the locale, so the instance's translations
        // answer in the language the interface is in
        client.i18n.setLocale("ar");
        await client.send("/api/hello", { method: "GET" });
        assert.equal(net.calls[1].headers["Accept-Language"], "ar");

        // uninstalling leaves the client's own lang travelling again
        client.unuse("i18n");
        await client.send("/api/hello", { method: "GET" });
        assert.equal(net.calls[2].headers["Accept-Language"], "en-US");

        // and with header: false the plugin never touches a request
        const quiet = new Client("http://test").use(
            i18n({ catalogues: CATALOGUES, locale: "ar", header: false }),
        );
        assert.equal(quiet.hooks.beforeSend.size, 0);
        await quiet.send("/api/hello", { method: "GET" });
        assert.equal(net.calls[3].headers["Accept-Language"], "en-US");
    });
});
