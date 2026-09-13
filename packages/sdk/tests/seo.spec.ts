// @vitest-environment jsdom

import { describe, assert, test, beforeEach, afterEach } from "vitest";
import Client from "@/Client";
import { ClientResponseError } from "@/ClientResponseError";
import { seo, seoHead, SeoMeta } from "@/seo";
import { dummyJWT } from "./mocks";

interface Call {
    url: string;
    method: string;
    headers: { [key: string]: string };
    signal: any;
}

const META: SeoMeta = {
    canonical: "https://site.test/blog/hello",
    title: "Hello & welcome",
    description: "The first post",
    image: "https://site.test/api/seo/og/posts/p1.svg",
    type: "Article",
    locale: "en",
    alternates: [
        { locale: "en", url: "https://site.test/blog/hello" },
        { locale: "ar", url: "https://site.test/blog/hello?locale=ar" },
        { locale: "x-default", url: "https://site.test/blog/hello" },
    ],
    jsonld: {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "Hello & welcome",
        url: "https://site.test/blog/hello",
    },
    og: {
        "og:title": "Hello & welcome",
        "og:description": "The first post",
        "og:url": "https://site.test/blog/hello",
        "og:type": "article",
        "og:site_name": "Site",
        "og:image": "https://site.test/api/seo/og/posts/p1.svg",
        "og:locale": "en_US",
        "og:locale:alternate": ["ar_AR"],
    },
    twitter: {
        "twitter:card": "summary_large_image",
        "twitter:title": "Hello & welcome",
        "twitter:description": "The first post",
        "twitter:image": "https://site.test/api/seo/og/posts/p1.svg",
    },
    html: '<title>Hello &amp; welcome</title>\n<link rel="canonical" href="https://site.test/blog/hello">',
};

/**
 * A fetch that records every call and answers each with the scripted
 * reply (a 200 with the meta above by default).
 */
class NetworkMock {
    calls: Array<Call> = [];
    replies: Array<{ status: number; body: any }> = [];
    private originalFetch?: typeof fetch;

    init() {
        this.originalFetch = global.fetch;
        global.fetch = async (url: any, config: any) => {
            this.calls.push({
                url: String(url),
                method: config?.method || "GET",
                headers: config?.headers || {},
                signal: config?.signal,
            });

            // a tick, so that an abort in between is seen
            await new Promise((resolve) => setTimeout(resolve, 1));
            if (config?.signal?.aborted) {
                const err = new Error("The operation was aborted.");
                err.name = "AbortError";
                throw err;
            }

            const reply = this.replies.shift() || { status: 200, body: META };

            return {
                url: String(url),
                status: reply.status,
                json: async () => reply.body,
            } as Response;
        };
    }

    restore() {
        global.fetch = this.originalFetch!;
    }
}

const VALID_TOKEN = dummyJWT({ exp: Math.floor(Date.now() / 1000) + 3600 });

/**
 * The head's elements but the title (which `document.title` creates).
 */
function headTags(doc: Document = document): Array<string> {
    return Array.from(doc.head.children)
        .filter((el) => el.tagName !== "TITLE")
        .map((el) => el.outerHTML);
}

describe("seo()", function () {
    const net = new NetworkMock();
    let pb: Client;

    beforeEach(function () {
        net.init();
        net.calls = [];
        net.replies = [];
        document.head.innerHTML = "";
        document.title = "";
        pb = new Client("http://test");
    });

    afterEach(function () {
        pb.unuse("seo");
        net.restore();
    });

    test("Should install as a plugin, attach client.seo and remove it on uninstall", function () {
        const client = pb.use(seo());

        assert.deepEqual(client.plugins, ["seo"]);
        assert.isFunction(client.seo.meta);
        assert.isFunction(client.seo.apply);
        assert.isFunction(client.seo.shareImage);

        client.unuse("seo");
        assert.isUndefined((client as any).seo);
    });

    test("Should ask /api/seo/meta for a path or a record through client.send", async function () {
        const client = pb.use(seo());
        pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);
        const seen: Array<string> = [];
        pb.hooks.beforeSend.add((url) => {
            seen.push(url);
        });

        const controller = new AbortController();
        const byPath = await client.seo.meta(
            { path: "/blog/hello" },
            { signal: controller.signal },
        );
        assert.deepEqual(byPath, META);
        assert.lengthOf(net.calls, 1);
        const first = new URL(net.calls[0].url);
        assert.equal(first.origin + first.pathname, "http://test/api/seo/meta");
        assert.equal(first.searchParams.get("path"), "/blog/hello");
        assert.isNull(first.searchParams.get("collection"));
        assert.equal(net.calls[0].method, "GET");
        assert.equal(net.calls[0].headers["Authorization"], VALID_TOKEN);
        assert.equal(net.calls[0].signal, controller.signal);
        assert.lengthOf(seen, 1);

        // a newer call cancels an older one still in flight, unless it has its own signal
        const older = client.seo.meta({ path: "/blog/older" }).then(
            () => null,
            (err) => err,
        );
        await client.seo.meta({ collection: "posts", id: "p1" });
        const cancelled = await older;
        assert.instanceOf(cancelled, ClientResponseError);
        assert.isTrue(cancelled.isAbort);
        assert.notEqual(net.calls[1].signal, controller.signal);
        const second = new URL(net.calls[2].url);
        assert.equal(second.pathname, "/api/seo/meta");
        assert.equal(second.searchParams.get("collection"), "posts");
        assert.equal(second.searchParams.get("id"), "p1");
        assert.isNull(second.searchParams.get("path"));

        // a refused or unknown page is the usual error
        net.replies = [{ status: 404, body: { message: "No such page." } }];
        try {
            await client.seo.meta({ path: "/nowhere" });
            assert.fail("expected a throw");
        } catch (err: any) {
            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 404);
        }
    });

    test("Should build the share image URL", function () {
        const client = pb.use(seo());

        assert.equal(
            client.seo.shareImage("posts", "p1"),
            "http://test/api/seo/og/posts/p1.svg",
        );
        assert.equal(
            client.seo.shareImage("posts", "p1", "png"),
            "http://test/api/seo/og/posts/p1.png",
        );
        assert.equal(
            client.seo.shareImage("my posts", "a/b"),
            "http://test/api/seo/og/my%20posts/a%2Fb.svg",
        );
    });

    describe("apply()", function () {
        test("Should write the tags into document.head, marked, and leave one set after two applies", function () {
            const client = pb.use(seo());

            client.seo.apply(META);

            assert.equal(document.title, "Hello & welcome");
            const once = headTags();
            assert.deepEqual(once, [
                '<link rel="canonical" href="https://site.test/blog/hello" data-vb-seo="">',
                '<meta name="description" content="The first post" data-vb-seo="">',
                '<link rel="alternate" hreflang="en" href="https://site.test/blog/hello" data-vb-seo="">',
                '<link rel="alternate" hreflang="ar" href="https://site.test/blog/hello?locale=ar" data-vb-seo="">',
                '<link rel="alternate" hreflang="x-default" href="https://site.test/blog/hello" data-vb-seo="">',
                '<meta property="og:title" content="Hello &amp; welcome" data-vb-seo="">',
                '<meta property="og:description" content="The first post" data-vb-seo="">',
                '<meta property="og:url" content="https://site.test/blog/hello" data-vb-seo="">',
                '<meta property="og:type" content="article" data-vb-seo="">',
                '<meta property="og:image" content="https://site.test/api/seo/og/posts/p1.svg" data-vb-seo="">',
                '<meta property="og:locale" content="en_US" data-vb-seo="">',
                '<meta property="og:site_name" content="Site" data-vb-seo="">',
                '<meta property="og:locale:alternate" content="ar_AR" data-vb-seo="">',
                '<meta name="twitter:card" content="summary_large_image" data-vb-seo="">',
                '<meta name="twitter:title" content="Hello &amp; welcome" data-vb-seo="">',
                '<meta name="twitter:description" content="The first post" data-vb-seo="">',
                '<meta name="twitter:image" content="https://site.test/api/seo/og/posts/p1.svg" data-vb-seo="">',
                '<script type="application/ld+json" data-vb-seo="">' +
                    JSON.stringify(META.jsonld) +
                    "</script>",
            ]);

            // the same again: nothing doubled
            client.seo.apply(META);
            assert.deepEqual(headTags(), once);

            // another page: only its tags remain
            client.seo.apply({
                canonical: "https://site.test/about",
                title: "About",
                jsonld: [],
            });
            assert.equal(document.title, "About");
            assert.deepEqual(headTags(), [
                '<link rel="canonical" href="https://site.test/about" data-vb-seo="">',
                '<meta property="og:title" content="About" data-vb-seo="">',
                '<meta property="og:url" content="https://site.test/about" data-vb-seo="">',
                '<meta name="twitter:card" content="summary" data-vb-seo="">',
                '<meta name="twitter:title" content="About" data-vb-seo="">',
            ]);
            assert.lengthOf(
                document.head.querySelectorAll('meta[property="og:locale:alternate"]'),
                0,
            );
            assert.lengthOf(document.head.querySelectorAll("script"), 0);
        });

        test("Should update the tags the page already had instead of doubling them, and keep the rest", function () {
            const client = pb.use(seo());
            document.head.innerHTML =
                '<meta charset="utf-8">' +
                '<link rel="canonical" href="https://site.test/old">' +
                '<meta property="og:title" content="Old">' +
                '<meta name="viewport" content="width=device-width">';

            client.seo.apply({ canonical: "https://site.test/new", title: "New" });

            assert.deepEqual(headTags(), [
                '<meta charset="utf-8">',
                '<link rel="canonical" href="https://site.test/new" data-vb-seo="">',
                '<meta property="og:title" content="New" data-vb-seo="">',
                '<meta name="viewport" content="width=device-width">',
                '<meta property="og:url" content="https://site.test/new" data-vb-seo="">',
                '<meta name="twitter:card" content="summary" data-vb-seo="">',
                '<meta name="twitter:title" content="New" data-vb-seo="">',
            ]);
            assert.lengthOf(document.head.querySelectorAll('link[rel="canonical"]'), 1);

            // a document of your own, and the plugin's own og:/twitter: keys with or without prefix
            const doc = document.implementation.createHTMLDocument("Other");
            client.seo.apply(
                {
                    title: "T",
                    og: { see_also: "https://site.test/x" },
                    twitter: { site: "@site" },
                },
                doc,
            );
            assert.equal(doc.title, "T");
            assert.equal(
                doc.head
                    .querySelector('meta[property="og:see_also"]')
                    ?.getAttribute("content"),
                "https://site.test/x",
            );
            assert.equal(
                doc.head
                    .querySelector('meta[name="twitter:site"]')
                    ?.getAttribute("content"),
                "@site",
            );
            assert.lengthOf(
                document.head.querySelectorAll('meta[name="twitter:site"]'),
                0,
            );
        });
    });
});

describe("seoHead()", function () {
    test("Should answer the html the route sent", function () {
        assert.equal(seoHead(META), META.html);
        assert.equal(seoHead({ title: "T", html: "" }), "");
    });

    test("Should build the fragment from the fields, escaped", function () {
        const html = seoHead({
            canonical: 'https://site.test/a?b=1&c="2"',
            title: 'Tom & "Jerry" <3',
            description: "A <b>bold</b> claim",
            jsonld: { "@type": "Thing", name: "</script><script>alert(1)</script>" },
            alternates: [{ locale: "ar", url: "https://site.test/a?locale=ar" }],
            og: { type: "website" },
            twitter: { card: "summary" },
        });

        assert.deepEqual(html.split("\n"), [
            "<title>Tom &amp; &quot;Jerry&quot; &lt;3</title>",
            '<link rel="canonical" href="https://site.test/a?b=1&amp;c=&quot;2&quot;">',
            '<meta name="description" content="A &lt;b&gt;bold&lt;/b&gt; claim">',
            '<link rel="alternate" hreflang="ar" href="https://site.test/a?locale=ar">',
            '<meta property="og:title" content="Tom &amp; &quot;Jerry&quot; &lt;3">',
            '<meta property="og:description" content="A &lt;b&gt;bold&lt;/b&gt; claim">',
            '<meta property="og:url" content="https://site.test/a?b=1&amp;c=&quot;2&quot;">',
            '<meta property="og:type" content="website">',
            '<meta name="twitter:card" content="summary">',
            '<meta name="twitter:title" content="Tom &amp; &quot;Jerry&quot; &lt;3">',
            '<meta name="twitter:description" content="A &lt;b&gt;bold&lt;/b&gt; claim">',
            '<script type="application/ld+json">{"@type":"Thing","name":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}</script>',
        ]);
        assert.notInclude(html, "</script><script>");

        // what a browser reads back is the same JSON
        const json = html.match(
            /<script type="application\/ld\+json">(.*)<\/script>/,
        )![1];
        assert.deepEqual(JSON.parse(json), {
            "@type": "Thing",
            name: "</script><script>alert(1)</script>",
        });

        assert.equal(seoHead({}), "");
    });
});
