// @vitest-environment jsdom

import { describe, assert, test, beforeEach, afterEach, vi } from "vitest";
import Client from "@/Client";
import { editable, EditTarget } from "@/editable";
import { dummyJWT } from "./mocks";

interface Call {
    url: string;
    method: string;
    body: any;
}

/**
 * A fetch that records every call and answers each with the scripted
 * status (200 by default, echoing the body over the id; a GET answers
 * `record` over the id). The can-update route is answered from
 * `permission` and recorded apart, so that it does not shift a scripted
 * reply meant for a read or a write.
 */
class NetworkMock {
    calls: Array<Call> = [];
    permissionCalls: Array<Call> = [];
    replies: Array<number> = [];
    record: { [key: string]: any } = {};
    permission: any = {
        allowed: true,
        fields: ["title", "body", "content"],
        reason: null,
    };
    permissionStatus = 200;
    private originalFetch?: typeof fetch;

    init() {
        this.originalFetch = global.fetch;
        global.fetch = async (url: any, config: any) => {
            const body =
                typeof config?.body === "string" ? JSON.parse(config.body) : config?.body;

            if (String(url).endsWith("/can-update")) {
                this.permissionCalls.push({
                    url: String(url),
                    method: config?.method || "GET",
                    body,
                });
                return {
                    url: String(url),
                    status: this.permissionStatus,
                    json: async () =>
                        this.permissionStatus >= 400
                            ? // what an instance without the route answers
                              { status: this.permissionStatus, message: "Not Found.", data: {} }
                            : this.permission,
                } as Response;
            }

            this.calls.push({ url: String(url), method: config?.method || "GET", body });

            const status = this.replies.shift() ?? 200;
            const id = String(url).split("/").pop();
            const replyBody =
                status >= 400
                    ? { message: "refused" }
                    : Object.assign(
                          { id, collectionName: "posts" },
                          config?.method === "GET" ? this.record : body,
                      );

            return {
                url: String(url),
                status,
                json: async () => replyBody,
            } as Response;
        };
    }

    restore() {
        global.fetch = this.originalFetch!;
    }
}

const VALID_TOKEN = dummyJWT({ exp: Math.floor(Date.now() / 1000) + 3600 });

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function fire(el: Element, type: string, init: any = {}): boolean {
    const e =
        type === "keydown"
            ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
            : new Event(type, { bubbles: type === "input", cancelable: true, ...init });
    return el.dispatchEvent(e);
}

describe("editable()", function () {
    const net = new NetworkMock();
    let pb: Client;

    beforeEach(function () {
        net.init();
        net.calls = [];
        net.permissionCalls = [];
        net.replies = [];
        net.record = {};
        net.permission = {
            allowed: true,
            fields: ["title", "body", "content"],
            reason: null,
        };
        net.permissionStatus = 200;
        document.body.innerHTML = `
            <h1 id="title" data-vb-edit="posts:abc:title">Hello</h1>
            <p id="body" data-vb-edit="posts:abc:body" data-vb-edit-multiline>Text</p>
            <span id="other" data-vb-edit="posts:def:title">Other</span>
            <div id="plain">plain</div>
            <div id="broken" data-vb-edit="posts:abc">broken</div>
        `;
        pb = new Client("http://test");
        pb.authStore.clear();
    });

    afterEach(function () {
        pb.unuse("editable");
        pb.authStore.clear();
        net.restore();
        vi.useRealTimers();
    });

    const title = () => document.getElementById("title")!;
    const body = () => document.getElementById("body")!;
    const other = () => document.getElementById("other")!;
    const editableIds = () =>
        Array.from(document.querySelectorAll("[contenteditable]")).map((el) => el.id);

    function signIn() {
        pb.authStore.save(VALID_TOKEN, { id: "u1", collectionName: "users" } as any);
    }

    /**
     * Lets whatever is pending settle, with real or with fake timers: the
     * elements the instance allows become editable one round trip after a
     * scan, not in the same breath as it.
     */
    async function settle(): Promise<void> {
        if (vi.isFakeTimers()) {
            await vi.advanceTimersByTimeAsync(0);
        } else {
            await tick();
        }
    }

    async function signedIn(): Promise<void> {
        signIn();
        await settle();
    }

    test("Should install as a plugin, attach client.editable and touch nothing while signed out", function () {
        const client = pb.use(editable());

        assert.deepEqual(client.plugins, ["editable"]);
        assert.isFalse(client.editable.enabled);
        assert.isFunction(client.editable.refresh);
        assert.deepEqual(editableIds(), []);
    });

    test("Should toggle contenteditable with the auth state", async function () {
        const client = pb.use(editable());

        await signedIn();
        assert.isTrue(client.editable.enabled);
        assert.deepEqual(editableIds(), ["title", "body", "other"]);
        assert.equal(title().getAttribute("contenteditable"), "true");
        assert.isFalse(document.getElementById("plain")!.hasAttribute("contenteditable"));
        assert.isFalse(
            document.getElementById("broken")!.hasAttribute("contenteditable"),
        );

        pb.authStore.clear();
        assert.isFalse(client.editable.enabled);
        assert.deepEqual(editableIds(), []);
    });

    test("Should be enabled at install when already signed in and let canEdit veto", async function () {
        signIn();
        pb.use(
            editable({
                canEdit: (record, field) => !(record.id === "abc" && field === "body"),
            }),
        );
        await settle();

        assert.deepEqual(editableIds(), ["title", "other"]);
    });

    test("Should pick up elements added later and forget removed ones", async function () {
        pb.use(editable());
        await signedIn();

        const added = document.createElement("div");
        added.innerHTML = '<em id="late" data-vb-edit="posts:ghi:title">late</em>';
        document.body.appendChild(added);
        await tick();
        assert.include(editableIds(), "late");

        // a mark changed is followed
        title().setAttribute("data-vb-edit", "posts:zzz:title");
        await tick();
        title().textContent = "Moved";
        fire(title(), "blur");
        await tick();
        assert.equal(net.calls[0].url, "http://test/api/collections/posts/records/zzz");

        added.remove();
        await tick();
        assert.notInclude(editableIds(), "late");
    });

    test("Should save on blur through update with the field and mark the state", async function () {
        vi.useFakeTimers();
        const saved: Array<[EditTarget, string, any]> = [];
        pb.use(
            editable({ idleTimeout: 1000, onSaved: (t, v, r) => saved.push([t, v, r]) }),
        );
        await signedIn();

        title().textContent = "Changed";
        fire(title(), "blur");
        assert.equal(title().getAttribute("data-vb-state"), "saving");

        await vi.advanceTimersByTimeAsync(0);

        assert.lengthOf(net.calls, 1);
        assert.equal(net.calls[0].method, "PATCH");
        assert.equal(net.calls[0].url, "http://test/api/collections/posts/records/abc");
        assert.deepEqual(net.calls[0].body, { title: "Changed" });
        assert.equal(title().getAttribute("data-vb-state"), "saved");
        assert.equal(title().textContent, "Changed");

        assert.lengthOf(saved, 1);
        assert.deepEqual(saved[0][0], { collection: "posts", id: "abc", field: "title" });
        assert.equal(saved[0][1], "Changed");
        assert.equal(saved[0][2].title, "Changed");

        // the marker is cleared after a moment
        await vi.advanceTimersByTimeAsync(1000);
        assert.isFalse(title().hasAttribute("data-vb-state"));

        // an unchanged element does not save again
        fire(title(), "blur");
        await vi.advanceTimersByTimeAsync(0);
        assert.lengthOf(net.calls, 1);
    });

    test("Should save on Enter for a single-line element and not for a multiline one", async function () {
        pb.use(editable());
        await signedIn();

        title().textContent = "By Enter";
        const kept = fire(title(), "keydown", { key: "Enter" });
        assert.isFalse(kept); // the newline is prevented
        await tick();
        assert.lengthOf(net.calls, 1);
        assert.deepEqual(net.calls[0].body, { title: "By Enter" });

        body().textContent = "Line 1\nLine 2";
        assert.isTrue(fire(body(), "keydown", { key: "Enter" }));
        await tick();
        assert.lengthOf(net.calls, 1);

        fire(body(), "blur");
        await tick();
        assert.lengthOf(net.calls, 2);
        assert.deepEqual(net.calls[1].body, { body: "Line 1\nLine 2" });
    });

    test("Should debounce input and save after the pause", async function () {
        vi.useFakeTimers();
        pb.use(editable({ debounce: 400 }));
        await signedIn();

        title().textContent = "T";
        fire(title(), "input");
        await vi.advanceTimersByTimeAsync(300);
        title().textContent = "Ty";
        fire(title(), "input");
        await vi.advanceTimersByTimeAsync(300);
        assert.lengthOf(net.calls, 0);

        await vi.advanceTimersByTimeAsync(100);
        assert.lengthOf(net.calls, 1);
        assert.deepEqual(net.calls[0].body, { title: "Ty" });
    });

    test("Should revert on Escape without saving", async function () {
        vi.useFakeTimers();
        pb.use(editable());
        await signedIn();

        title().textContent = "Nope";
        fire(title(), "input");
        fire(title(), "keydown", { key: "Escape" });

        assert.equal(title().textContent, "Hello");
        await vi.advanceTimersByTimeAsync(1000);
        assert.lengthOf(net.calls, 0);
    });

    test("Should revert on error, mark it and call onError", async function () {
        vi.useFakeTimers();
        const errors: Array<[EditTarget, string, any]> = [];
        pb.use(
            editable({ idleTimeout: 500, onError: (t, v, e) => errors.push([t, v, e]) }),
        );
        await signedIn();
        net.replies = [400];

        other().textContent = "Refused";
        fire(other(), "blur");
        await vi.advanceTimersByTimeAsync(0);

        assert.lengthOf(net.calls, 1);
        assert.equal(other().textContent, "Other");
        assert.equal(other().getAttribute("data-vb-state"), "error");
        assert.lengthOf(errors, 1);
        assert.deepEqual(errors[0][0], {
            collection: "posts",
            id: "def",
            field: "title",
        });
        assert.equal(errors[0][1], "Refused");
        assert.equal(errors[0][2].status, 400);

        await vi.advanceTimersByTimeAsync(500);
        assert.isFalse(other().hasAttribute("data-vb-state"));

        // after a successful save, Escape and an error revert to the saved text
        other().textContent = "Kept";
        fire(other(), "blur");
        await vi.advanceTimersByTimeAsync(0);
        net.replies = [403];
        other().textContent = "Refused again";
        fire(other(), "blur");
        await vi.advanceTimersByTimeAsync(0);
        assert.equal(other().textContent, "Kept");
    });

    test("Should save the latest text after a save in flight", async function () {
        pb.use(editable());
        await signedIn();

        title().textContent = "One";
        fire(title(), "blur");
        title().textContent = "Two";
        fire(title(), "blur");
        await tick();
        await tick();

        assert.lengthOf(net.calls, 2);
        assert.deepEqual(net.calls[0].body, { title: "One" });
        assert.deepEqual(net.calls[1].body, { title: "Two" });
    });

    test("Should clean up on uninstall", async function () {
        const client = pb.use(editable());
        await signedIn();
        assert.deepEqual(editableIds(), ["title", "body", "other"]);

        client.unuse("editable");
        assert.isUndefined((client as any).editable);
        assert.deepEqual(editableIds(), []);
        assert.isFalse(title().hasAttribute("data-vb-state"));

        // neither the observer nor the auth listener are left behind
        const late = document.createElement("b");
        late.setAttribute("data-vb-edit", "posts:abc:title");
        document.body.appendChild(late);
        await tick();
        pb.authStore.clear();
        await signedIn();
        assert.deepEqual(editableIds(), []);

        title().textContent = "After";
        fire(title(), "blur");
        await tick();
        assert.lengthOf(net.calls, 0);
    });

    test("Should do nothing without a document", function () {
        vi.stubGlobal("document", undefined);
        try {
            const client = pb.use(editable());
            signIn();
            assert.isFalse(client.editable.enabled);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    describe("markdown", function () {
        const RENDERED = "<p>Some <strong>bold</strong> text</p>";
        const SOURCE = "Some **bold** text";

        const md = () => document.getElementById("md")!;
        const surface = () =>
            document.querySelector(".vb-editable-markdown") as HTMLElement | null;
        const textarea = () =>
            document.querySelector(
                ".vb-editable-markdown textarea",
            ) as HTMLTextAreaElement | null;
        const button = (action: string) =>
            document.querySelector(
                '.vb-editable-toolbar [data-vb-action="' + action + '"]',
            ) as HTMLButtonElement;
        const preview = () =>
            document.querySelector(".vb-editable-preview") as HTMLElement | null;

        beforeEach(function () {
            document.body.insertAdjacentHTML(
                "beforeend",
                '<div id="md" data-vb-edit="posts:abc:body" data-vb-edit-markdown>' +
                    RENDERED +
                    "</div>",
            );
            net.record = { body: SOURCE };
        });

        /**
         * Opens the editor (by click, which works whether or not the element
         * already has the focus) and lets the source arrive.
         */
        async function open(): Promise<HTMLTextAreaElement> {
            await settle(); // the element is editable one round trip after a scan
            md().click();
            await tick();
            await tick();
            return textarea()!;
        }

        test("Should swap the element for a textarea with the fetched source and a toolbar on focus", async function () {
            pb.use(editable());
            await signedIn();

            assert.isFalse(md().hasAttribute("contenteditable"));
            assert.equal(md().getAttribute("tabindex"), "0");
            assert.isNull(surface());

            md().focus();
            assert.isOk(surface());
            assert.equal(surface()!.previousElementSibling, md());
            assert.equal(md().style.display, "none");
            assert.isTrue(textarea()!.disabled); // until the source arrives

            await tick();
            await tick();
            assert.lengthOf(net.calls, 1);
            assert.equal(net.calls[0].method, "GET");
            assert.equal(
                net.calls[0].url,
                "http://test/api/collections/posts/records/abc?fields=body",
            );
            assert.isFalse(textarea()!.disabled);
            assert.equal(textarea()!.value, SOURCE);
            assert.equal(document.activeElement, textarea());
            assert.deepEqual(
                Array.from(document.querySelectorAll(".vb-editable-toolbar button")).map(
                    (b) => b.getAttribute("data-vb-action"),
                ),
                ["bold", "italic", "heading", "link", "list", "code", "save", "cancel"],
            );

            // Cancel puts the element back untouched; a second edit does not fetch again
            button("cancel").click();
            assert.isNull(surface());
            assert.equal(md().style.display, "");
            assert.equal(md().innerHTML, RENDERED);

            md().click();
            await tick();
            assert.lengthOf(net.calls, 1);
            assert.equal(textarea()!.value, SOURCE);
            assert.isFalse(textarea()!.disabled);
        });

        test("Should apply markdown around the selection from the toolbar and the shortcuts", async function () {
            pb.use(editable());
            await signedIn();
            const ta = await open();

            ta.setSelectionRange(0, 4); // "Some"
            button("bold").click();
            assert.equal(ta.value, "**Some** **bold** text");
            assert.equal(ta.selectionStart, 2);
            assert.equal(ta.selectionEnd, 6);
            button("bold").click(); // and off again
            assert.equal(ta.value, SOURCE);

            ta.setSelectionRange(14, 18); // "text"
            fire(ta, "keydown", { key: "i", ctrlKey: true });
            assert.equal(ta.value, "Some **bold** *text*");

            ta.setSelectionRange(0, 0);
            button("heading").click();
            assert.equal(ta.value, "# Some **bold** *text*");
            button("heading").click();
            assert.equal(ta.value, "Some **bold** *text*");

            ta.setSelectionRange(0, 4); // "Some"
            fire(ta, "keydown", { key: "k", metaKey: true });
            assert.equal(ta.value, "[Some](url) **bold** *text*");
            assert.equal(ta.value.slice(ta.selectionStart, ta.selectionEnd), "url");

            ta.value = "one\ntwo";
            ta.setSelectionRange(0, 7);
            button("list").click();
            assert.equal(ta.value, "- one\n- two");
            button("code").click();
            assert.equal(ta.value, "```\n- one\n- two\n```");

            ta.value = "x";
            ta.setSelectionRange(0, 1);
            button("code").click();
            assert.equal(ta.value, "`x`");

            assert.lengthOf(net.calls, 1); // nothing was saved
            assert.equal(document.activeElement, ta);
        });

        test("Should save the source through update and render it into the element", async function () {
            vi.useFakeTimers();
            const saved: Array<[EditTarget, string, any]> = [];
            pb.use(
                editable({
                    idleTimeout: 1000,
                    render: (m) => "<p>" + m.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + "</p>",
                    onSaved: (t, v, r) => saved.push([t, v, r]),
                }),
            );
            await signedIn();

            md().focus();
            await vi.advanceTimersByTimeAsync(0);
            const ta = textarea()!;
            assert.equal(ta.value, SOURCE);

            ta.value = "Now **strong**";
            button("save").click();
            assert.isNull(surface());
            assert.equal(md().getAttribute("data-vb-state"), "saving");
            assert.equal(md().innerHTML, RENDERED); // until the server accepts

            await vi.advanceTimersByTimeAsync(0);
            assert.lengthOf(net.calls, 2);
            assert.equal(net.calls[1].method, "PATCH");
            assert.equal(net.calls[1].url, "http://test/api/collections/posts/records/abc");
            assert.deepEqual(net.calls[1].body, { body: "Now **strong**" });
            assert.equal(md().innerHTML, "<p>Now <b>strong</b></p>");
            assert.equal(md().getAttribute("data-vb-state"), "saved");
            assert.lengthOf(saved, 1);
            assert.deepEqual(saved[0][0], { collection: "posts", id: "abc", field: "body" });
            assert.equal(saved[0][1], "Now **strong**");
            assert.equal(saved[0][2].body, "Now **strong**");

            await vi.advanceTimersByTimeAsync(1000);
            assert.isFalse(md().hasAttribute("data-vb-state"));

            // the next edit starts from the saved source, and an unchanged Save does nothing
            md().focus();
            assert.equal(textarea()!.value, "Now **strong**");
            button("save").click();
            await vi.advanceTimersByTimeAsync(0);
            assert.lengthOf(net.calls, 2);
        });

        test("Should put the element back on Escape and Cancel without saving", async function () {
            vi.useFakeTimers();
            pb.use(editable());
            await signedIn();

            md().focus();
            await vi.advanceTimersByTimeAsync(0);
            textarea()!.value = "Discarded";
            assert.isFalse(fire(textarea()!, "keydown", { key: "Escape" }));
            assert.isNull(surface());
            assert.equal(md().innerHTML, RENDERED);
            assert.equal(md().style.display, "");

            md().focus();
            assert.equal(textarea()!.value, SOURCE);
            textarea()!.value = "Also discarded";
            button("cancel").click();
            assert.isNull(surface());
            assert.equal(md().innerHTML, RENDERED);

            await vi.advanceTimersByTimeAsync(1000);
            assert.lengthOf(net.calls, 1); // the fetch only
        });

        test("Should save on blur unless saveOnBlur is false, and show the source as text without render", async function () {
            pb.use(editable());
            await signedIn();
            const ta = await open();

            ta.value = "Plain <i>source</i>";
            fire(ta, "blur");
            await tick();
            assert.isNull(surface());
            assert.lengthOf(net.calls, 2);
            assert.deepEqual(net.calls[1].body, { body: "Plain <i>source</i>" });
            assert.equal(md().textContent, "Plain <i>source</i>");
            assert.equal(md().innerHTML, "Plain &lt;i&gt;source&lt;/i&gt;");

            pb.unuse("editable");
            pb.use(editable({ saveOnBlur: false }));
            const kept = await open();
            kept.value = "Kept open";
            fire(kept, "blur");
            await tick();
            assert.isOk(surface());
            assert.lengthOf(net.calls, 3); // the new editor fetched again
            button("save").click();
            await tick();
            assert.lengthOf(net.calls, 4);
            assert.deepEqual(net.calls[3].body, { body: "Kept open" });
        });

        test("Should keep the element and revert the source when the save or the fetch fails", async function () {
            const errors: Array<[EditTarget, string, any]> = [];
            pb.use(editable({ onError: (t, v, e) => errors.push([t, v, e]) }));
            await signedIn();

            net.replies = [500];
            md().focus();
            await tick();
            await tick();
            assert.isNull(surface()); // the fetch failed: the editor went away
            assert.equal(md().getAttribute("data-vb-state"), "error");
            assert.lengthOf(errors, 1);
            assert.equal(errors[0][1], "");
            assert.equal(errors[0][2].status, 500);

            const ta = await open();
            assert.equal(ta.value, SOURCE);
            net.replies = [403];
            ta.value = "Refused";
            button("save").click();
            await tick();
            assert.equal(md().innerHTML, RENDERED);
            assert.equal(md().getAttribute("data-vb-state"), "error");
            assert.lengthOf(errors, 2);
            assert.deepEqual(errors[1][0], { collection: "posts", id: "abc", field: "body" });
            assert.equal(errors[1][1], "Refused");
            assert.equal(errors[1][2].status, 403);

            md().focus();
            assert.equal(textarea()!.value, SOURCE);
        });

        test("Should land a realtime change unless the editor is open, and clean up on uninstall", async function () {
            let cb: ((e: any) => void) | null = null;
            pb.collection("posts").subscribe = async (_topic: string, fn: any) => {
                cb = fn;
                return async () => {};
            };
            const client = pb.use(editable({ realtime: true, render: (m) => "<p>" + m + "</p>" }));
            await signedIn();
            await tick();

            cb!({ action: "update", record: { id: "abc", body: "From elsewhere" } });
            assert.equal(md().innerHTML, "<p>From elsewhere</p>");

            const ta = await open();
            assert.equal(ta.value, "From elsewhere");
            assert.lengthOf(net.calls, 0); // the realtime change is the source
            cb!({ action: "update", record: { id: "abc", body: "Meanwhile" } });
            assert.equal(ta.value, "From elsewhere");

            client.unuse("editable");
            assert.isNull(surface());
            assert.equal(md().style.display, "");
            assert.isFalse(md().hasAttribute("tabindex"));
        });

        test("Should render a preview beside the textarea and update it after the pause", async function () {
            vi.useFakeTimers();
            pb.use(
                editable({
                    debounce: 400,
                    render: (m) => "<p>" + m.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + "</p>",
                }),
            );
            await signedIn();

            md().focus();
            await vi.advanceTimersByTimeAsync(0);

            const pane = preview()!;
            assert.isOk(pane);
            assert.equal(pane.parentElement!.className, "vb-editable-panes");
            assert.equal(pane.previousElementSibling, textarea());
            assert.equal(pane.innerHTML, "<p>Some <b>bold</b> text</p>");
            assert.isNull(button("preview")); // the pane is there; nothing to toggle

            // what is typed reaches it after the same pause as a save
            const ta = textarea()!;
            ta.value = "Now **strong**";
            fire(ta, "input");
            assert.equal(pane.innerHTML, "<p>Some <b>bold</b> text</p>");
            await vi.advanceTimersByTimeAsync(400);
            assert.equal(pane.innerHTML, "<p>Now <b>strong</b></p>");

            // and so does what the toolbar writes
            ta.setSelectionRange(0, 3);
            button("bold").click();
            await vi.advanceTimersByTimeAsync(400);
            assert.equal(pane.innerHTML, "<p><b>Now</b> <b>strong</b></p>");

            // the editor closing takes the pane with it
            button("cancel").click();
            assert.isNull(preview());
        });

        test("Should offer a Preview button with preview: toggle, and neither pane nor button without one", async function () {
            const render = (m: string) => "<p>" + m + "</p>";

            pb.use(editable({ debounce: 0, render, preview: "toggle" }));
            signIn();
            const ta = await open();

            assert.deepEqual(
                Array.from(document.querySelectorAll(".vb-editable-toolbar button")).map(
                    (b) => b.getAttribute("data-vb-action"),
                ),
                ["bold", "italic", "heading", "link", "list", "code", "preview", "save", "cancel"],
            );
            assert.equal(preview()!.style.display, "none");
            assert.equal(button("preview").getAttribute("aria-pressed"), "false");

            button("preview").click();
            assert.equal(preview()!.style.display, "");
            assert.equal(preview()!.innerHTML, "<p>Some **bold** text</p>");
            assert.equal(button("preview").getAttribute("aria-pressed"), "true");

            ta.value = "Changed";
            fire(ta, "input");
            assert.equal(preview()!.innerHTML, "<p>Changed</p>");

            button("preview").click();
            assert.equal(preview()!.style.display, "none");
            assert.lengthOf(net.calls, 1); // the fetch only: nothing was saved

            // preview: false leaves the textarea alone, and so does a
            // missing render however the option is set
            pb.unuse("editable");
            pb.use(editable({ render, preview: false }));
            await open();
            assert.isNull(preview());
            assert.isNull(button("preview"));
            assert.isNull(document.querySelector(".vb-editable-panes"));

            pb.unuse("editable");
            pb.use(editable({ preview: "toggle" }));
            await open();
            assert.isNull(preview());
            assert.isNull(button("preview"));
        });
    });

    describe("permissions", function () {
        const url = (id: string) =>
            "http://test/api/collections/posts/records/" + id + "/can-update";

        test("Should ask the instance once per record before the element is editable", async function () {
            const client = pb.use(editable());
            await signedIn();

            assert.deepEqual(
                net.permissionCalls.map((c) => c.url),
                [url("abc"), url("def")], // two elements share the record abc
            );
            assert.equal(net.permissionCalls[0].method, "GET");
            assert.deepEqual(editableIds(), ["title", "body", "other"]);

            // a second scan, and an element of a record already asked about,
            // ask nothing again
            client.editable.refresh();
            const late = document.createElement("em");
            late.setAttribute("data-vb-edit", "posts:abc:title");
            document.body.appendChild(late);
            await tick();
            assert.lengthOf(net.permissionCalls, 2);
            assert.equal(late.getAttribute("contenteditable"), "true");

            // another token may get another answer, so it is asked again
            pb.authStore.clear();
            await signedIn();
            assert.lengthOf(net.permissionCalls, 4);
        });

        test("Should leave the element alone when the record is refused or the field is not writable", async function () {
            net.permission = {
                allowed: false,
                fields: [],
                reason: "the collection's update rule does not admit you",
            };
            pb.use(editable());
            await signedIn();

            assert.deepEqual(editableIds(), []);
            assert.lengthOf(net.permissionCalls, 2);

            // allowed, but not every field of it
            pb.unuse("editable");
            net.permission = { allowed: true, fields: ["title"], reason: null };
            pb.use(editable());
            await settle();

            assert.deepEqual(editableIds(), ["title", "other"]);
            assert.lengthOf(net.calls, 0); // nothing was written to find out
        });

        test("Should enable the element as it did before when the instance has no such route", async function () {
            net.permissionStatus = 404;
            const client = pb.use(editable());
            await signedIn();

            assert.deepEqual(editableIds(), ["title", "body", "other"]);

            // the save is what finds out, and a refused one reverts
            net.replies = [403];
            title().textContent = "Refused";
            fire(title(), "blur");
            await tick();
            assert.lengthOf(net.calls, 1);
            assert.equal(title().textContent, "Hello");

            // an instance answering 405 is the same
            client.unuse("editable");
            net.permissionStatus = 405;
            pb.use(editable());
            await settle();
            assert.deepEqual(editableIds(), ["title", "body", "other"]);
        });

        test("Should let canEdit veto what the instance allows, and ask nothing about a vetoed element", async function () {
            pb.use(editable({ canEdit: (record) => record.id !== "abc" }));
            await signedIn();

            assert.deepEqual(editableIds(), ["other"]);
            assert.deepEqual(
                net.permissionCalls.map((c) => c.url),
                [url("def")],
            );
        });
    });

    describe("realtime", function () {
        test("Should subscribe once per collection with the ids, land changes and unsubscribe on uninstall", async function () {
            const subscriptions: Array<{
                topic: string;
                filter?: string;
                cb: (e: any) => void;
            }> = [];
            let unsubscribed = 0;
            const service = pb.collection("posts");
            service.subscribe = async (topic: string, cb: any, options?: any) => {
                subscriptions.push({ topic, filter: options?.filter, cb });
                return async () => {
                    unsubscribed++;
                };
            };

            const client = pb.use(editable({ realtime: true }));
            await signedIn();
            await tick();

            assert.lengthOf(subscriptions, 1);
            assert.equal(subscriptions[0].topic, "*");
            assert.equal(subscriptions[0].filter, 'id = "abc" || id = "def"');

            subscriptions[0].cb({
                action: "update",
                record: { id: "abc", title: "From elsewhere", body: "New body" },
            });
            assert.equal(title().textContent, "From elsewhere");
            assert.equal(body().textContent, "New body");
            assert.equal(other().textContent, "Other");

            // Escape now reverts to what arrived
            title().textContent = "typing";
            fire(title(), "keydown", { key: "Escape" });
            assert.equal(title().textContent, "From elsewhere");

            // one element gone: the subscription is replaced with the ids left
            other().remove();
            await tick();
            await tick();
            assert.equal(unsubscribed, 1);
            assert.lengthOf(subscriptions, 2);
            assert.equal(subscriptions[1].filter, 'id = "abc"');

            client.unuse("editable");
            await tick();
            assert.equal(unsubscribed, 2);
        });
    });
});
