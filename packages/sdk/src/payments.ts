// The payments helper, as a plugin: @voidbase-cloud/sdk/payments
//
// Installed, it attaches `client.payments`: `checkout`, `portal` and
// `cancel` post to the instance's /api/payments/<provider>/... routes
// through client.send, so the auth token and the hook lists apply, and
// `mine()` lists the customers, subscriptions and payments collections the
// way any record listing does (their rules already scope them to the
// signed-in user). Which provider the instance routes payments to is read
// once per client from GET /api/plugins (its `payments` field) and cached;
// that route is a superuser's today, so a refusal falls back to the
// `provider` option, and without one throws an error that says to pass it.
// The plugin imports only types from the core package, so this entry
// carries no second copy of the client.

import type Client from "@voidbase-cloud/sdk";
import type { Plugin, RecordModel } from "@voidbase-cloud/sdk";

export type PaymentsProvider = "stripe" | "polar" | "lemonsqueezy";

/**
 * Where the instance routes payments (the `payments` field of
 * GET /api/plugins).
 */
export interface PaymentsRoute {
    via: PaymentsProvider | "none";
    webhook?: string;
    livemode?: boolean;
}

export interface PaymentsOptions {
    /**
     * The provider to use when /api/plugins cannot be read (a client that
     * is not a superuser's). Not needed when the route answers.
     */
    provider?: PaymentsProvider;
}

/**
 * One line of a checkout: a price id at the provider and how many.
 */
export interface PaymentsItem {
    price: string;
    quantity?: number;
}

export interface PaymentsCheckoutOptions {
    /**
     * Where the provider sends the customer after paying.
     */
    success: string;

    /**
     * Where the provider sends the customer who backs out.
     */
    cancel: string;

    /**
     * A one-off payment or a subscription (default: the instance's).
     */
    mode?: "payment" | "subscription";
}

export interface PaymentsPortalOptions {
    /**
     * Where the provider's portal sends the customer back to.
     */
    return: string;
}

export interface PaymentsCancelOptions {
    /**
     * Cancel immediately instead of at the end of the paid period
     * (default: false).
     */
    now?: boolean;
}

/**
 * What /api/payments/<provider>/cancel answers.
 */
export interface PaymentsCancelReply {
    subscription: string;
    status: string;
    cancelAtPeriodEnd: boolean;
}

/**
 * The signed-in user's rows, as `mine()` answers them.
 */
export interface PaymentsMine<
    C extends RecordModel = RecordModel,
    S extends RecordModel = RecordModel,
    P extends RecordModel = RecordModel,
> {
    /**
     * The customers row, or null before the first checkout.
     */
    customer: C | null;
    subscriptions: Array<S>;
    payments: Array<P>;
}

/**
 * The controller attached as `client.payments`.
 */
export interface PaymentsController {
    /**
     * Where the instance routes payments, read once and cached; without
     * access to /api/plugins the `provider` option, as `{ via }`.
     */
    provider(): Promise<PaymentsRoute>;

    /**
     * Starts a checkout for the signed-in user and answers the URL to send
     * them to.
     */
    checkout(
        items: Array<PaymentsItem>,
        options: PaymentsCheckoutOptions,
    ): Promise<{ url: string }>;

    /**
     * Opens the provider's billing portal for the signed-in user and
     * answers the URL to send them to.
     */
    portal(options: PaymentsPortalOptions): Promise<{ url: string }>;

    /**
     * Cancels one of the signed-in user's subscriptions (the id of its
     * subscriptions row).
     */
    cancel(
        subscription: string,
        options?: PaymentsCancelOptions,
    ): Promise<PaymentsCancelReply>;

    /**
     * `checkout(...)` and then, in a browser, `location.href = url`; on the
     * server only the URL.
     */
    redirectToCheckout(
        items: Array<PaymentsItem>,
        options: PaymentsCheckoutOptions,
    ): Promise<{ url: string }>;

    /**
     * `portal(...)` and then, in a browser, `location.href = url`; on the
     * server only the URL.
     */
    redirectToPortal(options: PaymentsPortalOptions): Promise<{ url: string }>;

    /**
     * The signed-in user's customer, subscriptions and payments, listed
     * from the collections of those names.
     */
    mine<
        C extends RecordModel = RecordModel,
        S extends RecordModel = RecordModel,
        P extends RecordModel = RecordModel,
    >(): Promise<PaymentsMine<C, S, P>>;
}

/**
 * A client with the payments plugin installed (what `client.use(payments())` answers).
 */
export type PaymentsClient<T extends Client = Client> = T & {
    payments: PaymentsController;
};

function isRefusal(err: any): boolean {
    return !!err && (err.status === 401 || err.status === 403);
}

function redirect(url: string): void {
    try {
        if (typeof location !== "undefined" && location) {
            location.href = url;
        }
    } catch (_) {} // no navigation here (a worker, a sandboxed frame)
}

class Controller implements PaymentsController {
    private route?: Promise<PaymentsRoute>;

    constructor(
        private client: Client,
        private options: PaymentsOptions,
    ) {}

    provider(): Promise<PaymentsRoute> {
        if (!this.route) {
            this.route = this.client
                .send<{ payments?: PaymentsRoute }>("/api/plugins", {
                    method: "GET",
                    requestKey: null,
                })
                .then((info): PaymentsRoute => info?.payments || { via: "none" })
                .catch((err): PaymentsRoute => {
                    if (isRefusal(err) && this.options.provider) {
                        return { via: this.options.provider } as PaymentsRoute;
                    }
                    delete this.route; // a later call may be allowed
                    if (isRefusal(err)) {
                        throw new Error(
                            "payments: GET /api/plugins is a superuser's, so pass the provider to payments({ provider: 'stripe' | 'polar' | 'lemonsqueezy' }).",
                        );
                    }
                    throw err;
                });
        }

        return this.route;
    }

    private async base(): Promise<string> {
        const { via } = await this.provider();
        if (via === "none") {
            throw new Error(
                "payments: no payments provider is configured on this instance.",
            );
        }
        return "/api/payments/" + encodeURIComponent(via);
    }

    async checkout(
        items: Array<PaymentsItem>,
        options: PaymentsCheckoutOptions,
    ): Promise<{ url: string }> {
        const body: { [key: string]: any } = {
            items: items.map((item) => ({
                price: item.price,
                quantity: item.quantity ?? 1,
            })),
            success: options.success,
            cancel: options.cancel,
        };
        if (typeof options.mode !== "undefined") {
            body.mode = options.mode;
        }

        return this.client.send<{ url: string }>((await this.base()) + "/checkout", {
            method: "POST",
            body,
            requestKey: null,
        });
    }

    async portal(options: PaymentsPortalOptions): Promise<{ url: string }> {
        return this.client.send<{ url: string }>((await this.base()) + "/portal", {
            method: "POST",
            body: { return: options.return },
            requestKey: null,
        });
    }

    async cancel(
        subscription: string,
        options: PaymentsCancelOptions = {},
    ): Promise<PaymentsCancelReply> {
        return this.client.send<PaymentsCancelReply>((await this.base()) + "/cancel", {
            method: "POST",
            body: { subscription, now: !!options.now },
            requestKey: null,
        });
    }

    async redirectToCheckout(
        items: Array<PaymentsItem>,
        options: PaymentsCheckoutOptions,
    ): Promise<{ url: string }> {
        const reply = await this.checkout(items, options);
        redirect(reply.url);
        return reply;
    }

    async redirectToPortal(options: PaymentsPortalOptions): Promise<{ url: string }> {
        const reply = await this.portal(options);
        redirect(reply.url);
        return reply;
    }

    async mine<
        C extends RecordModel = RecordModel,
        S extends RecordModel = RecordModel,
        P extends RecordModel = RecordModel,
    >(): Promise<PaymentsMine<C, S, P>> {
        const [customers, subscriptions, payments] = await Promise.all([
            this.client.collection("customers").getFullList<C>({ requestKey: null }),
            this.client.collection("subscriptions").getFullList<S>({ requestKey: null }),
            this.client.collection("payments").getFullList<P>({ requestKey: null }),
        ]);

        return { customer: customers[0] || null, subscriptions, payments };
    }
}

/**
 * The payments plugin.
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { payments } from "@voidbase-cloud/sdk/payments";
 *
 * const pb = new PocketBase("https://example.com").use(payments({ provider: "stripe" }));
 *
 * await pb.payments.redirectToCheckout([{ price: "price_123" }], {
 *     success: location.origin + "/thanks",
 *     cancel: location.href,
 * });
 *
 * const { customer, subscriptions } = await pb.payments.mine();
 * ```
 *
 * `client.unuse("payments")` removes `client.payments`.
 */
export function payments(
    options: PaymentsOptions = {},
): Plugin<{ payments: PaymentsController }> {
    return {
        name: "payments",
        install(client: Client) {
            (client as PaymentsClient).payments = new Controller(client, options);

            return () => {
                delete (client as any).payments;
            };
        },
    };
}
