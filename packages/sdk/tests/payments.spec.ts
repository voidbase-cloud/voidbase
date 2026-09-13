import { describe, assert, test, beforeEach, afterEach, vi } from "vitest";
import Client from "@/Client";
import { ClientResponseError } from "@/ClientResponseError";
import { payments, PaymentsProvider } from "@/payments";
import { dummyJWT } from "./mocks";

interface Call {
    url: string;
    method: string;
    headers: { [key: string]: string };
    body: any;
}

/**
 * A fetch that records every call and answers each from the scripted
 * replies by URL prefix (a 200 with `{ url }` for checkout and portal,
 * the plugins inventory for /api/plugins, an empty listing for records).
 */
class NetworkMock {
    calls: Array<Call> = [];
    plugins: { status: number; body: any } = {
        status: 200,
        body: {
            payments: {
                via: "stripe",
                webhook: "/api/payments/stripe/webhook",
                livemode: false,
            },
        },
    };
    records: { [collection: string]: Array<any> } = {};
    private originalFetch?: typeof fetch;

    init() {
        this.originalFetch = global.fetch;
        global.fetch = async (url: any, config: any) => {
            const body =
                typeof config?.body === "string" ? JSON.parse(config.body) : config?.body;
            this.calls.push({
                url: String(url),
                method: config?.method || "GET",
                headers: config?.headers || {},
                body,
            });

            let reply: { status: number; body: any };
            const path = String(url).replace("http://test", "");
            const records = path.match(/^\/api\/collections\/([^/]+)\/records/);
            if (path.startsWith("/api/plugins")) {
                reply = this.plugins;
            } else if (records) {
                const items = this.records[records[1]] || [];
                reply = {
                    status: 200,
                    body: {
                        items,
                        page: 1,
                        perPage: 500,
                        totalItems: items.length,
                        totalPages: 1,
                    },
                };
            } else if (path.endsWith("/cancel")) {
                reply = {
                    status: 200,
                    body: {
                        subscription: body.subscription,
                        status: "canceled",
                        cancelAtPeriodEnd: false,
                    },
                };
            } else {
                reply = {
                    status: 200,
                    body: {
                        url: "https://provider.test/session/" + path.split("/").pop(),
                    },
                };
            }

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

describe("payments()", function () {
    const net = new NetworkMock();
    let pb: Client;

    beforeEach(function () {
        net.init();
        net.calls = [];
        net.records = {};
        net.plugins = {
            status: 200,
            body: {
                payments: {
                    via: "stripe",
                    webhook: "/api/payments/stripe/webhook",
                    livemode: false,
                },
            },
        };
        pb = new Client("http://test");
    });

    afterEach(function () {
        pb.unuse("payments");
        net.restore();
        vi.unstubAllGlobals();
    });

    test("Should install as a plugin, attach client.payments and remove it on uninstall", function () {
        const client = pb.use(payments());

        assert.deepEqual(client.plugins, ["payments"]);
        assert.isFunction(client.payments.checkout);
        assert.isFunction(client.payments.portal);
        assert.isFunction(client.payments.cancel);
        assert.isFunction(client.payments.mine);
        assert.isFunction(client.payments.provider);

        client.unuse("payments");
        assert.isUndefined((client as any).payments);
    });

    test("Should read the provider from /api/plugins once and cache it", async function () {
        const client = pb.use(payments());

        const route = await client.payments.provider();
        assert.deepEqual(route, {
            via: "stripe",
            webhook: "/api/payments/stripe/webhook",
            livemode: false,
        });
        assert.lengthOf(net.calls, 1);
        assert.equal(net.calls[0].url, "http://test/api/plugins");
        assert.equal(net.calls[0].method, "GET");

        await client.payments.provider();
        await client.payments.checkout([{ price: "price_1" }], {
            success: "s",
            cancel: "c",
        });
        assert.lengthOf(net.calls, 2); // the inventory was not read again

        // an instance without a provider
        client.unuse("payments");
        net.plugins = { status: 200, body: { payments: { via: "none" } } };
        const bare = pb.use(payments());
        assert.deepEqual(await bare.payments.provider(), { via: "none" });
        await bare.payments
            .checkout([{ price: "price_1" }], { success: "s", cancel: "c" })
            .then(
                () => assert.fail("expected a throw"),
                (err) => assert.match(err.message, /no payments provider/),
            );
    });

    test("Should fall back to the provider option when /api/plugins is refused, or say to pass it", async function () {
        net.plugins = { status: 403, body: { message: "Only superusers." } };

        const client = pb.use(payments({ provider: "polar" }));
        assert.deepEqual(await client.payments.provider(), { via: "polar" });
        await client.payments.portal({ return: "https://app.test/account" });
        assert.equal(net.calls[1].url, "http://test/api/payments/polar/portal");
        assert.lengthOf(net.calls, 2); // the refusal is cached too

        // the option is not used while the route answers
        client.unuse("payments");
        net.plugins = { status: 200, body: { payments: { via: "stripe" } } };
        const answered = pb.use(payments({ provider: "polar" }));
        assert.equal((await answered.payments.provider()).via, "stripe");

        // no option: a clear error, and a later call tries again
        answered.unuse("payments");
        net.plugins = {
            status: 401,
            body: { message: "The request requires valid record authorization token." },
        };
        const none = pb.use(payments());
        net.calls = [];
        try {
            await none.payments.checkout([{ price: "price_1" }], {
                success: "s",
                cancel: "c",
            });
            assert.fail("expected a throw");
        } catch (err: any) {
            assert.notInstanceOf(err, ClientResponseError);
            assert.match(err.message, /superuser/);
            assert.match(err.message, /payments\(\{ provider/);
        }
        assert.lengthOf(net.calls, 1);
        net.plugins = { status: 200, body: { payments: { via: "lemonsqueezy" } } };
        assert.equal((await none.payments.provider()).via, "lemonsqueezy");
        assert.lengthOf(net.calls, 2);

        // any other failure is thrown as it is
        none.unuse("payments");
        net.plugins = { status: 500, body: { message: "Boom." } };
        const broken = pb.use(payments({ provider: "stripe" }));
        try {
            await broken.payments.provider();
            assert.fail("expected a throw");
        } catch (err: any) {
            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 500);
        }
    });

    test("Should post checkout, portal and cancel to the provider's routes with the auth token", async function () {
        const providers: Array<PaymentsProvider> = ["stripe", "polar", "lemonsqueezy"];
        pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);

        for (const provider of providers) {
            net.plugins = { status: 200, body: { payments: { via: provider } } };
            const client = pb.use(payments());
            net.calls = [];

            const checkout = await client.payments.checkout(
                [{ price: "price_pro" }, { price: "price_seat", quantity: 3 }],
                {
                    success: "https://app.test/thanks",
                    cancel: "https://app.test/pricing",
                    mode: "subscription",
                },
            );
            assert.deepEqual(checkout, { url: "https://provider.test/session/checkout" });
            assert.equal(
                net.calls[1].url,
                `http://test/api/payments/${provider}/checkout`,
            );
            assert.equal(net.calls[1].method, "POST");
            assert.equal(net.calls[1].headers["Content-Type"], "application/json");
            assert.equal(net.calls[1].headers["Authorization"], VALID_TOKEN);
            assert.deepEqual(net.calls[1].body, {
                items: [
                    { price: "price_pro", quantity: 1 },
                    { price: "price_seat", quantity: 3 },
                ],
                success: "https://app.test/thanks",
                cancel: "https://app.test/pricing",
                mode: "subscription",
            });

            // without a mode none is sent
            await client.payments.checkout([{ price: "price_once" }], {
                success: "s",
                cancel: "c",
            });
            assert.deepEqual(net.calls[2].body, {
                items: [{ price: "price_once", quantity: 1 }],
                success: "s",
                cancel: "c",
            });

            const portal = await client.payments.portal({
                return: "https://app.test/account",
            });
            assert.deepEqual(portal, { url: "https://provider.test/session/portal" });
            assert.equal(net.calls[3].url, `http://test/api/payments/${provider}/portal`);
            assert.equal(net.calls[3].method, "POST");
            assert.deepEqual(net.calls[3].body, { return: "https://app.test/account" });

            const canceled = await client.payments.cancel("sub_1", { now: true });
            assert.deepEqual(canceled, {
                subscription: "sub_1",
                status: "canceled",
                cancelAtPeriodEnd: false,
            });
            assert.equal(net.calls[4].url, `http://test/api/payments/${provider}/cancel`);
            assert.deepEqual(net.calls[4].body, { subscription: "sub_1", now: true });

            await client.payments.cancel("sub_2");
            assert.deepEqual(net.calls[5].body, { subscription: "sub_2", now: false });

            client.unuse("payments");
        }
    });

    test("Should throw the ClientResponseError of a refused checkout", async function () {
        const client = pb.use(payments({ provider: "stripe" }));
        net.plugins = { status: 403, body: {} };
        const original = global.fetch;
        global.fetch = async (url: any, config: any) => {
            if (String(url).endsWith("/checkout")) {
                return {
                    url,
                    status: 401,
                    json: async () => ({ message: "Sign in first." }),
                } as any;
            }
            return original(url, config);
        };

        try {
            await client.payments.checkout([{ price: "price_1" }], {
                success: "s",
                cancel: "c",
            });
            assert.fail("expected a throw");
        } catch (err: any) {
            assert.instanceOf(err, ClientResponseError);
            assert.equal(err.status, 401);
            assert.equal(err.url, "http://test/api/payments/stripe/checkout");
        } finally {
            global.fetch = original;
        }
    });

    test("Should redirect in a browser and only answer the url on the server", async function () {
        const client = pb.use(payments());

        // no location: the server
        const server = await client.payments.redirectToCheckout([{ price: "p" }], {
            success: "s",
            cancel: "c",
        });
        assert.deepEqual(server, { url: "https://provider.test/session/checkout" });

        // a browser
        const location = { href: "https://app.test/pricing" };
        vi.stubGlobal("location", location);

        const checkout = await client.payments.redirectToCheckout([{ price: "p" }], {
            success: "s",
            cancel: "c",
        });
        assert.equal(location.href, "https://provider.test/session/checkout");
        assert.deepEqual(checkout, { url: "https://provider.test/session/checkout" });

        const portal = await client.payments.redirectToPortal({ return: "r" });
        assert.equal(location.href, "https://provider.test/session/portal");
        assert.deepEqual(portal, { url: "https://provider.test/session/portal" });
    });

    test("Should list the signed-in user's customer, subscriptions and payments", async function () {
        const client = pb.use(payments({ provider: "stripe" }));
        pb.authStore.save(VALID_TOKEN, { id: "u1" } as any);
        net.records = {
            customers: [
                { id: "c1", user: "u1", provider: "stripe", providerId: "cus_1" },
            ],
            subscriptions: [
                { id: "s1", customer: "c1", status: "active", cancelAtPeriodEnd: false },
                {
                    id: "s2",
                    customer: "c1",
                    status: "canceled",
                    cancelAtPeriodEnd: false,
                },
            ],
            payments: [{ id: "p1", customer: "c1", status: "succeeded", amount: 1200 }],
        };

        const mine = await client.payments.mine();
        assert.deepEqual(mine, {
            customer: net.records.customers[0],
            subscriptions: net.records.subscriptions,
            payments: net.records.payments,
        });

        const urls = net.calls.map((c) => c.url.replace(/\?.*$/, "")).sort();
        assert.deepEqual(urls, [
            "http://test/api/collections/customers/records",
            "http://test/api/collections/payments/records",
            "http://test/api/collections/subscriptions/records",
        ]);
        assert.lengthOf(net.calls, 3); // no /api/plugins for a listing
        for (const call of net.calls) {
            assert.equal(call.method, "GET");
            assert.equal(call.headers["Authorization"], VALID_TOKEN);
        }

        // before the first checkout
        net.records = {};
        assert.deepEqual(await client.payments.mine(), {
            customer: null,
            subscriptions: [],
            payments: [],
        });
    });
});
