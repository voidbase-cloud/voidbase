// In-place editing of rendered records: @voidbase-cloud/sdk/editable
//
// An element marked `data-vb-edit="collection:id:field"` becomes
// contenteditable while the client is authenticated, and what is typed into
// it is saved through client.collection(collection).update(id, { field }).
// An element also marked `data-vb-edit-markdown` edits the field's markdown
// source instead: on focus it is swapped for a textarea with a small toolbar,
// a rendered preview beside it when a `render` is given, and Save writes the
// source through the same update. Before an element gets its affordance the
// instance is asked whether this caller may write the field
// (GET .../records/:id/can-update). The plugin touches no element that is
// not marked. It imports only types from the core package, so this entry
// carries no second copy of the client.

import type Client from "@voidbase-cloud/sdk";
import type { Plugin, RecordModel, UnsubscribeFunc } from "@voidbase-cloud/sdk";

/**
 * What an element edits: the record and the field.
 */
export interface EditTarget {
    collection: string;
    id: string;
    field: string;
}

/**
 * What `GET /api/collections/:collection/records/:id/can-update` answers
 * (voidbase 0.9.0-beta.38 and up): whether this caller's token may write
 * the record, and which fields a PATCH of it would take.
 */
export interface EditPermission {
    allowed: boolean;
    fields: Array<string>;
    reason: string | null;
}

export interface EditableOptions {
    /**
     * The attribute that marks an element, holding "collection:id:field"
     * (default: "data-vb-edit"). `<attribute>-multiline` on the element
     * lets Enter insert a line instead of saving; `<attribute>-markdown`
     * edits the field's markdown source in a textarea instead of the text.
     */
    attribute?: string;

    /**
     * Where to look for marked elements (default: document).
     */
    root?: ParentNode;

    /**
     * A veto per element, asked whenever an element would become editable
     * (default: every marked element is, once the client is authenticated
     * and the instance says the caller may write the field). It is asked
     * before the instance is, so a vetoed element costs no request, and it
     * is never overridden by the instance saying yes.
     */
    canEdit?: (record: { collection: string; id: string }, field: string) => boolean;

    /**
     * Called after a save the server accepted, with the record it answered.
     */
    onSaved?: (target: EditTarget, value: string, record: RecordModel) => void;

    /**
     * Called after a save the server refused; the element has been reverted.
     */
    onError?: (target: EditTarget, value: string, error: any) => void;

    /**
     * The pause after the last keystroke before the text is saved while the
     * element is still focused, in milliseconds (default: 400).
     */
    debounce?: number;

    /**
     * How long the `data-vb-state` marker ("saved" or "error") stays on the
     * element before it is cleared, in milliseconds (default: 1500).
     */
    idleTimeout?: number;

    /**
     * Subscribe to realtime changes of the touched records, one
     * subscription per collection filtered to its ids, so that an edit made
     * elsewhere lands in the element (default: false).
     */
    realtime?: boolean;

    /**
     * Renders markdown source to HTML for a markdown element after a save
     * (and after a realtime change), for instance `marked.parse`. No
     * renderer is bundled: without one the element shows the source text.
     */
    render?: (markdown: string) => string;

    /**
     * Whether a markdown editor saves when its textarea loses focus, as
     * the text mode does (default: true). With false only Save saves.
     */
    saveOnBlur?: boolean;

    /**
     * Whether a markdown editor shows what `render` makes of the source
     * beside the textarea, updated as the person types and debounced by
     * `debounce` (default: true). With "toggle" the toolbar gets a Preview
     * button instead and the pane starts hidden; with false there is
     * neither. Without `render` there is no preview and no button.
     */
    preview?: boolean | "toggle";
}

/**
 * The controller attached as `client.editable`.
 */
export interface EditableController {
    /**
     * Whether marked elements are editable right now (the client is
     * authenticated and the plugin runs in a document).
     */
    readonly enabled: boolean;

    /**
     * Scans the root again for marked elements, for a DOM the observer
     * cannot see (a shadow root passed as `root` is observed; another is not).
     */
    refresh(): void;

    /**
     * Saves every element with unsaved text now.
     */
    flush(): Promise<void>;
}

/**
 * A client with the editable plugin installed (what `client.use(editable())` answers).
 */
export type EditableClient<T extends Client = Client> = T & {
    editable: EditableController;
};

type State = "saving" | "saved" | "error";

interface Entry extends EditTarget {
    el: HTMLElement;
    /**
     * The text as last saved (or first seen): what Escape and an error revert to.
     */
    original: string;
    /**
     * The text of the save in flight, if any.
     */
    pending: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    stateTimer: ReturnType<typeof setTimeout> | null;
    listeners: Array<[string, (e: any) => void]>;
    /**
     * Whether the element edits the field's markdown source in a textarea.
     */
    markdown: boolean;
    /**
     * The markdown source as last fetched, saved or edited; null until the
     * first edit fetches it.
     */
    source: string | null;
    /**
     * The editing surface in the element's place while it is edited.
     */
    surface: HTMLElement | null;
    textarea: HTMLTextAreaElement | null;
    /**
     * The rendered preview beside the textarea, while the editor is open
     * and a `render` was given.
     */
    preview: HTMLElement | null;
    previewButton: HTMLButtonElement | null;
    previewTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Whether the preview pane is showing; kept across opens so that a
     * toggled preview stays toggled.
     */
    previewOn: boolean;
    /**
     * The element's inline display, put back when the surface goes.
     */
    display: string;
    /**
     * Whether the plugin gave the element its tabindex.
     */
    tabindex: boolean;
}

/**
 * The markdown toolbar: action, label, title. The Preview button sits
 * between the two groups, and only with `preview: "toggle"`.
 */
const TOOLS: Array<[string, string, string]> = [
    ["bold", "B", "Bold (Ctrl+B)"],
    ["italic", "I", "Italic (Ctrl+I)"],
    ["heading", "H", "Heading"],
    ["link", "Link", "Link (Ctrl+K)"],
    ["list", "List", "Bulleted list"],
    ["code", "Code", "Code"],
];

const PREVIEW_TOOL: [string, string, string] = ["preview", "Preview", "Preview"];

const COMMIT_TOOLS: Array<[string, string, string]> = [
    ["save", "Save", "Save"],
    ["cancel", "Cancel", "Cancel (Escape)"],
];

const STATE_ATTR = "data-vb-state";

function parseTarget(value: string | null): EditTarget | null {
    if (!value) {
        return null;
    }

    const parts = value.split(":");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        return null;
    }

    return { collection: parts[0], id: parts[1], field: parts[2] };
}

function targetOf(entry: Entry): EditTarget {
    return { collection: entry.collection, id: entry.id, field: entry.field };
}

// --- textarea helpers ---

function replaceRange(
    ta: HTMLTextAreaElement,
    start: number,
    end: number,
    text: string,
): void {
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
}

/**
 * Wraps the selection in `before` and `after`, or unwraps it when it
 * already is; the selection stays on the same text.
 */
function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string): void {
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end);

    if (
        start >= before.length &&
        value.slice(start - before.length, start) === before &&
        value.slice(end, end + after.length) === after
    ) {
        replaceRange(ta, start - before.length, end + after.length, selected);
        ta.setSelectionRange(start - before.length, end - before.length);
        return;
    }

    replaceRange(ta, start, end, before + selected + after);
    ta.setSelectionRange(start + before.length, end + before.length);
}

/**
 * Prefixes every line the selection touches, or removes the prefix when
 * every one of them has it; the selection then covers those lines.
 */
function prefixLines(ta: HTMLTextAreaElement, prefix: string): void {
    const value = ta.value;
    const start = ta.selectionStart;
    let end = ta.selectionEnd;
    if (end > start && value[end - 1] === "\n") {
        end--; // a selection ending right after a newline does not touch the next line
    }

    const from = value.lastIndexOf("\n", start - 1) + 1;
    let to = value.indexOf("\n", end);
    if (to === -1) {
        to = value.length;
    }

    const lines = value.slice(from, to).split("\n");
    const all = lines.every((line) => line.startsWith(prefix));
    const changed = lines
        .map((line) => (all ? line.slice(prefix.length) : prefix + line))
        .join("\n");

    replaceRange(ta, from, to, changed);
    ta.setSelectionRange(from, from + changed.length);
}

/**
 * Makes the selection a link: a selected url becomes the target with the
 * text left to type, anything else becomes the text with "url" selected.
 */
function insertLink(ta: HTMLTextAreaElement): void {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    const isUrl = /^https?:\/\/\S+$/.test(selected);
    const text = isUrl ? "" : selected;
    const url = isUrl ? selected : "url";

    replaceRange(ta, start, end, "[" + text + "](" + url + ")");

    if (isUrl) {
        ta.setSelectionRange(start + 1, start + 1);
    } else {
        const at = start + text.length + 3;
        ta.setSelectionRange(at, at + url.length);
    }
}

class Editor implements EditableController {
    private entries = new Map<HTMLElement, Entry>();
    private observer: MutationObserver | null = null;
    private offAuth: (() => void) | null = null;
    private active = false;
    private subscriptions = new Map<
        string,
        { ids: string; chain: Promise<void>; off: UnsubscribeFunc | null }
    >();
    /**
     * What the instance answered about a record, by "collection/id", asked
     * once and kept for the session; null when it could not be asked.
     */
    private permissions = new Map<string, Promise<EditPermission | null>>();

    private attribute: string;
    private multilineAttribute: string;
    private markdownAttribute: string;
    private root: ParentNode | null;
    private canEdit: (
        record: { collection: string; id: string },
        field: string,
    ) => boolean;
    private debounce: number;
    private idleTimeout: number;
    private renderer: ((markdown: string) => string) | null;
    private saveOnBlur: boolean;
    private preview: boolean | "toggle";

    constructor(
        private client: Client,
        private options: EditableOptions,
    ) {
        this.attribute = options.attribute || "data-vb-edit";
        this.multilineAttribute = this.attribute + "-multiline";
        this.markdownAttribute = this.attribute + "-markdown";
        this.renderer = options.render || null;
        this.saveOnBlur = options.saveOnBlur !== false;
        this.preview =
            options.preview === "toggle" ? "toggle" : options.preview !== false;
        this.root = options.root || (typeof document !== "undefined" ? document : null);
        this.canEdit = options.canEdit || (() => true);
        this.debounce = typeof options.debounce === "number" ? options.debounce : 400;
        this.idleTimeout =
            typeof options.idleTimeout === "number" ? options.idleTimeout : 1500;
    }

    get enabled(): boolean {
        return this.active;
    }

    start(): void {
        if (!this.root) {
            return; // no document: nothing to edit (server-side)
        }

        this.offAuth = this.client.authStore.onChange(() => {
            this.permissions.clear(); // another token, another answer
            this.sync();
        });
        this.sync();

        if (typeof MutationObserver !== "undefined") {
            this.observer = new MutationObserver((records) => this.onMutations(records));
            this.observer.observe(this.root as Node, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: [this.attribute],
            });
        }
    }

    stop(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.offAuth?.();
        this.offAuth = null;

        for (const entry of Array.from(this.entries.values())) {
            this.detach(entry);
        }
        this.active = false;

        for (const sub of this.subscriptions.values()) {
            sub.chain = sub.chain
                .then(() => {
                    const off = sub.off;
                    sub.off = null;
                    return off?.();
                })
                .catch(() => {});
        }
        this.subscriptions.clear();
    }

    refresh(): void {
        this.sync();
    }

    async flush(): Promise<void> {
        const saves: Array<Promise<void>> = [];
        for (const entry of Array.from(this.entries.values())) {
            // a markdown editor still open saves what it holds, and stays open
            if (entry.textarea && !entry.textarea.disabled) {
                entry.source = entry.textarea.value;
            }
            saves.push(this.save(entry));
        }
        await Promise.all(saves);
    }

    // --- elements ---

    /**
     * Makes the state of every marked element under the root match the
     * auth state: attached while authenticated, detached otherwise.
     */
    private sync(): void {
        if (!this.root) {
            return;
        }

        this.active = this.client.authStore.isValid;

        if (!this.active) {
            for (const entry of Array.from(this.entries.values())) {
                this.detach(entry);
            }
            return;
        }

        const marked: Array<HTMLElement> = [];
        this.root.querySelectorAll("[" + this.attribute + "]").forEach((el) => {
            marked.push(el as HTMLElement);
        });
        this.considerAll(marked);
    }

    /**
     * Attaches the elements that should be editable, detaches those that no
     * longer should be, re-attaches those whose target changed. What must
     * go goes at once; what may become editable waits for the instance's
     * answer about every one of them and is then attached in a single pass,
     * so that a scan settles in one step.
     */
    private considerAll(els: Array<HTMLElement>): void {
        const waiting: Array<{ el: HTMLElement; target: EditTarget }> = [];

        for (const el of els) {
            const target = parseTarget(el.getAttribute(this.attribute));
            const entry = this.entries.get(el);

            const wanted =
                this.active &&
                !!target &&
                this.canEdit(
                    { collection: target.collection, id: target.id },
                    target.field,
                );

            if (!wanted) {
                if (entry) {
                    this.detach(entry);
                }
                continue;
            }

            if (entry) {
                if (
                    entry.collection === target!.collection &&
                    entry.id === target!.id &&
                    entry.field === target!.field
                ) {
                    continue;
                }
                this.detach(entry);
            }

            waiting.push({ el, target: target! });
        }

        if (!waiting.length) {
            return;
        }

        Promise.all(waiting.map((one) => this.writable(one.target))).then((answers) => {
            for (let i = 0; i < waiting.length; i++) {
                if (answers[i]) {
                    this.attachIfStill(waiting[i].el, waiting[i].target);
                }
            }
        });
    }

    /**
     * Attaches an element the instance allowed, unless what was true when
     * it was asked no longer is.
     */
    private attachIfStill(el: HTMLElement, target: EditTarget): void {
        if (!this.active || this.entries.has(el)) {
            return;
        }

        const now = parseTarget(el.getAttribute(this.attribute));
        if (
            !now ||
            now.collection !== target.collection ||
            now.id !== target.id ||
            now.field !== target.field
        ) {
            return; // the mark changed meanwhile: its own pass attaches it
        }

        const root = this.root as Node | null;
        if (root && typeof root.contains === "function" && !root.contains(el)) {
            return; // it was taken out of the page meanwhile
        }

        if (!this.canEdit({ collection: now.collection, id: now.id }, now.field)) {
            return;
        }

        this.attach(el, now);
    }

    /**
     * Whether the instance lets this caller write the field: the record is
     * asked about once and the answer kept, and an instance that does not
     * know the route leaves the element as editable as it was before, a
     * refused save reverting it.
     */
    private writable(target: EditTarget): Promise<boolean> {
        const key = target.collection + "/" + target.id;

        let pending = this.permissions.get(key);
        if (!pending) {
            pending = this.ask(target.collection, target.id);
            this.permissions.set(key, pending);
        }

        return pending.then(
            (permission) =>
                !permission ||
                (permission.allowed && permission.fields.indexOf(target.field) >= 0),
        );
    }

    private async ask(
        collection: string,
        id: string,
    ): Promise<EditPermission | null> {
        const path =
            "/api/collections/" +
            encodeURIComponent(collection) +
            "/records/" +
            encodeURIComponent(id) +
            "/can-update";

        try {
            const answer: any = await this.client.send(path, {
                method: "GET",
                requestKey: null,
            });

            if (!answer || typeof answer.allowed !== "boolean") {
                return null; // not the answer we know: leave the element be
            }

            return {
                allowed: answer.allowed,
                fields: Array.isArray(answer.fields)
                    ? answer.fields.map((field: any) => String(field))
                    : [],
                reason: typeof answer.reason === "string" ? answer.reason : null,
            };
        } catch (_) {
            // an instance without the route answers 404 or 405, as it does
            // for a record this caller may not see; either way the element
            // is left as it would have been before the route existed
            return null;
        }
    }

    private attach(el: HTMLElement, target: EditTarget): void {
        const markdown = el.hasAttribute(this.markdownAttribute);
        const entry: Entry = {
            ...target,
            el,
            original: markdown ? "" : el.textContent || "",
            pending: null,
            timer: null,
            stateTimer: null,
            listeners: [],
            markdown,
            source: null,
            surface: null,
            textarea: null,
            preview: null,
            previewButton: null,
            previewTimer: null,
            previewOn: this.preview === true,
            display: "",
            tabindex: false,
        };

        const on = (type: string, fn: (e: any) => void) => {
            el.addEventListener(type, fn);
            entry.listeners.push([type, fn]);
        };

        if (markdown) {
            // the element opens its editor on focus or click; the source is
            // fetched at the first edit, the rendered content stays until then
            if (!el.hasAttribute("tabindex")) {
                el.setAttribute("tabindex", "0");
                entry.tabindex = true;
            }
            on("focus", () => this.open(entry));
            on("click", () => this.open(entry));

            this.entries.set(el, entry);
            this.track(entry.collection);
            return;
        }

        on("input", () => {
            this.clearTimer(entry);
            if (this.debounce >= 0) {
                entry.timer = setTimeout(() => {
                    entry.timer = null;
                    this.save(entry);
                }, this.debounce);
            }
        });

        on("blur", () => {
            this.save(entry);
        });

        on("keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                this.revert(entry);
                el.blur();
            } else if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !el.hasAttribute(this.multilineAttribute)
            ) {
                e.preventDefault();
                this.save(entry);
                el.blur();
            }
        });

        el.setAttribute("contenteditable", "true");
        this.entries.set(el, entry);
        this.track(entry.collection);
    }

    private detach(entry: Entry): void {
        this.clearTimer(entry);
        if (entry.stateTimer) {
            clearTimeout(entry.stateTimer);
            entry.stateTimer = null;
        }
        for (const [type, fn] of entry.listeners) {
            entry.el.removeEventListener(type, fn);
        }
        this.close(entry);
        if (entry.tabindex) {
            entry.el.removeAttribute("tabindex");
        }
        entry.el.removeAttribute("contenteditable");
        entry.el.removeAttribute(STATE_ATTR);
        this.entries.delete(entry.el);
        this.track(entry.collection);
    }

    private onMutations(records: Array<MutationRecord>): void {
        const changed: Array<HTMLElement> = [];

        for (const record of records) {
            if (record.type === "attributes") {
                changed.push(record.target as HTMLElement);
                continue;
            }

            record.removedNodes.forEach((node) => {
                this.forEachMarked(node, (el) => {
                    const entry = this.entries.get(el);
                    if (entry && !(this.root as Node).contains(el)) {
                        this.detach(entry);
                    }
                });
            });

            if (this.active) {
                record.addedNodes.forEach((node) => {
                    this.forEachMarked(node, (el) => changed.push(el));
                });
            }
        }

        if (changed.length) {
            this.considerAll(changed); // one pass for the whole batch
        }
    }

    private forEachMarked(node: Node, fn: (el: HTMLElement) => void): void {
        if (node.nodeType !== 1) {
            return;
        }
        const el = node as HTMLElement;
        if (el.hasAttribute(this.attribute)) {
            fn(el);
        }
        el.querySelectorAll("[" + this.attribute + "]").forEach((child) => {
            fn(child as HTMLElement);
        });
    }

    // --- saving ---

    private clearTimer(entry: Entry): void {
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
    }

    /**
     * The value a save would write: the element's text, or the markdown
     * source as last fetched, saved or edited.
     */
    private current(entry: Entry): string {
        if (!entry.markdown) {
            return entry.el.textContent || "";
        }
        return entry.source === null ? entry.original : entry.source;
    }

    private revert(entry: Entry): void {
        this.clearTimer(entry);
        if (entry.markdown) {
            // the element still shows what was rendered before; only the
            // source goes back
            if (entry.source !== null) {
                entry.source = entry.original;
            }
            return;
        }
        entry.el.textContent = entry.original;
    }

    /**
     * Shows markdown source in its element: rendered through the `render`
     * option, or as text without one.
     */
    private show(entry: Entry, source: string): void {
        if (this.renderer) {
            entry.el.innerHTML = this.renderer(source);
        } else {
            entry.el.textContent = source;
        }
    }

    private setState(entry: Entry, state: State | null): void {
        if (entry.stateTimer) {
            clearTimeout(entry.stateTimer);
            entry.stateTimer = null;
        }

        if (!state) {
            entry.el.removeAttribute(STATE_ATTR);
            return;
        }

        entry.el.setAttribute(STATE_ATTR, state);

        if (state !== "saving") {
            entry.stateTimer = setTimeout(() => {
                entry.stateTimer = null;
                if (entry.el.getAttribute(STATE_ATTR) === state) {
                    entry.el.removeAttribute(STATE_ATTR);
                }
            }, this.idleTimeout);
        }
    }

    private async save(entry: Entry): Promise<void> {
        this.clearTimer(entry);

        const value = this.current(entry);
        if (value === entry.original || value === entry.pending) {
            return; // nothing new to save, or this very text is on its way
        }
        if (entry.pending !== null) {
            return; // an older text is on its way; the current one goes after it
        }

        const target = targetOf(entry);

        entry.pending = value;
        this.setState(entry, "saving");

        try {
            const record = await this.client
                .collection(entry.collection)
                .update(entry.id, { [entry.field]: value }, { requestKey: null });

            entry.pending = null;
            entry.original = value;
            if (this.entries.get(entry.el) === entry) {
                if (entry.markdown) {
                    this.show(entry, value);
                }
                this.setState(entry, "saved");
            }
            this.options.onSaved?.(target, value, record);
        } catch (err) {
            entry.pending = null;
            if (this.entries.get(entry.el) === entry) {
                this.revert(entry);
                this.setState(entry, "error");
            }
            this.options.onError?.(target, value, err);
            return;
        }

        // typed on (or saved again) while the save was in flight
        if (this.entries.get(entry.el) === entry && this.current(entry) !== value) {
            await this.save(entry);
        }
    }

    // --- markdown ---

    /**
     * Swaps the element for a toolbar and a textarea holding the markdown
     * source, fetched from the record at the first edit.
     */
    private open(entry: Entry): void {
        const el = entry.el;
        if (entry.surface || !el.parentNode) {
            return;
        }

        const doc = el.ownerDocument;
        const surface = doc.createElement("div");
        surface.className = "vb-editable-markdown";
        surface.style.display = "block";

        // the preview is whatever `render` makes of the source: without one
        // there is nothing to show, and no button offering to show it
        const previewed = !!this.renderer && this.preview !== false;

        const toolbar = doc.createElement("div");
        toolbar.className = "vb-editable-toolbar";
        toolbar.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px";

        const tools = TOOLS.concat(
            previewed && this.preview === "toggle" ? [PREVIEW_TOOL] : [],
            COMMIT_TOOLS,
        );

        for (const [action, label, title] of tools) {
            const button = doc.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.title = title;
            button.setAttribute("data-vb-action", action);
            // keep the focus, and the selection, in the textarea
            button.addEventListener("mousedown", (e) => e.preventDefault());
            button.addEventListener("click", () => this.action(entry, action));
            toolbar.appendChild(button);
            if (action === "preview") {
                entry.previewButton = button;
            }
        }

        const textarea = doc.createElement("textarea");
        textarea.className = "vb-editable-textarea";
        textarea.style.cssText =
            "display:block;width:100%;box-sizing:border-box;font:inherit";
        const rect = el.getBoundingClientRect();
        if (rect.width && !previewed) {
            textarea.style.width = rect.width + "px";
        }
        if (rect.height) {
            textarea.style.minHeight = rect.height + "px";
        }
        if (previewed) {
            // the two panes share the row, and the narrower the element the
            // sooner they wrap and the preview sits under the source
            textarea.style.flex = "1 1 260px";
            textarea.style.minWidth = "0";
            textarea.addEventListener("input", () => this.schedulePreview(entry));
        }

        textarea.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                this.action(entry, "cancel");
                return;
            }
            if (!(e.ctrlKey || e.metaKey) || e.altKey) {
                return;
            }
            const key = e.key.toLowerCase();
            const action =
                key === "b" ? "bold" : key === "i" ? "italic" : key === "k" ? "link" : null;
            if (action) {
                e.preventDefault();
                this.action(entry, action);
            }
        });
        textarea.addEventListener("blur", () => {
            if (entry.textarea === textarea && this.saveOnBlur) {
                this.action(entry, "save");
            }
        });

        surface.appendChild(toolbar);

        if (previewed) {
            const panes = doc.createElement("div");
            panes.className = "vb-editable-panes";
            panes.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";

            const preview = doc.createElement("div");
            preview.className = "vb-editable-preview";
            preview.style.cssText = "flex:1 1 260px;min-width:0;overflow:auto";
            if (!entry.previewOn) {
                preview.style.display = "none";
            }

            panes.appendChild(textarea);
            panes.appendChild(preview);
            surface.appendChild(panes);
            entry.preview = preview;
        } else {
            surface.appendChild(textarea);
        }

        entry.surface = surface;
        entry.textarea = textarea;
        entry.display = el.style.display;
        el.style.display = "none";
        el.parentNode.insertBefore(surface, el.nextSibling);

        if (entry.source !== null) {
            textarea.value = entry.source;
            this.paintPreview(entry);
            textarea.focus();
            return;
        }
        this.paintPreview(entry);

        // the first edit: the source comes from the record
        textarea.disabled = true;
        this.client
            .collection(entry.collection)
            .getOne(entry.id, { fields: entry.field, requestKey: null })
            .then(
                (record) => {
                    const value = record[entry.field];
                    const source =
                        value === null || typeof value === "undefined"
                            ? ""
                            : String(value);
                    if (entry.source === null) {
                        entry.source = source;
                        entry.original = source;
                    }
                    if (entry.textarea === textarea) {
                        textarea.disabled = false;
                        textarea.value = entry.source;
                        this.paintPreview(entry);
                        textarea.focus();
                    }
                },
                (err) => {
                    if (entry.textarea === textarea) {
                        this.close(entry);
                    }
                    if (this.entries.get(entry.el) === entry) {
                        this.setState(entry, "error");
                    }
                    this.options.onError?.(targetOf(entry), "", err);
                },
            );
    }

    /**
     * Removes the editing surface and shows the element again.
     */
    private close(entry: Entry): void {
        const surface = entry.surface;
        if (!surface) {
            return;
        }
        this.clearPreviewTimer(entry);
        entry.surface = null;
        entry.textarea = null;
        entry.preview = null;
        entry.previewButton = null;
        surface.remove();
        entry.el.style.display = entry.display;
    }

    // --- preview ---

    private clearPreviewTimer(entry: Entry): void {
        if (entry.previewTimer) {
            clearTimeout(entry.previewTimer);
            entry.previewTimer = null;
        }
    }

    /**
     * Renders the source into the preview pane after the same pause as a
     * save, so that a fast typist renders once rather than per keystroke.
     */
    private schedulePreview(entry: Entry): void {
        if (!entry.preview || !entry.previewOn) {
            return;
        }

        this.clearPreviewTimer(entry);

        if (this.debounce > 0) {
            entry.previewTimer = setTimeout(() => {
                entry.previewTimer = null;
                this.paintPreview(entry);
            }, this.debounce);
            return;
        }

        this.paintPreview(entry);
    }

    /**
     * Puts what the textarea holds through `render` into the preview pane
     * now, and marks the Preview button with the state of the pane.
     */
    private paintPreview(entry: Entry): void {
        this.clearPreviewTimer(entry);

        if (entry.previewButton) {
            entry.previewButton.setAttribute(
                "aria-pressed",
                entry.previewOn ? "true" : "false",
            );
        }

        const preview = entry.preview;
        if (!preview || !this.renderer) {
            return;
        }

        preview.style.display = entry.previewOn ? "" : "none";
        if (entry.previewOn) {
            preview.innerHTML = this.renderer(entry.textarea?.value || "");
        }
    }

    /**
     * A toolbar button or its shortcut.
     */
    private action(entry: Entry, action: string): void {
        const ta = entry.textarea;
        if (!ta || (ta.disabled && action !== "cancel" && action !== "preview")) {
            return;
        }

        switch (action) {
            case "preview":
                entry.previewOn = !entry.previewOn;
                this.paintPreview(entry);
                break;
            case "bold":
                wrapSelection(ta, "**", "**");
                break;
            case "italic":
                wrapSelection(ta, "*", "*");
                break;
            case "code": {
                const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
                if (selected.includes("\n")) {
                    wrapSelection(ta, "```\n", "\n```");
                } else {
                    wrapSelection(ta, "`", "`");
                }
                break;
            }
            case "heading":
                prefixLines(ta, "# ");
                break;
            case "list":
                prefixLines(ta, "- ");
                break;
            case "link":
                insertLink(ta);
                break;
            case "save":
                entry.source = ta.value;
                this.close(entry);
                this.save(entry);
                return;
            case "cancel":
                this.close(entry);
                return;
        }

        this.schedulePreview(entry); // what the toolbar wrote reaches the preview too
        ta.focus();
    }

    // --- realtime ---

    /**
     * Keeps the collection's subscription filtered to the ids of its
     * attached elements: one subscription per collection, replaced when the
     * set of ids changes, removed when it empties.
     */
    private track(collection: string): void {
        if (!this.options.realtime) {
            return;
        }

        const ids = new Set<string>();
        for (const entry of this.entries.values()) {
            if (entry.collection === collection) {
                ids.add(entry.id);
            }
        }
        const key = Array.from(ids).sort().join(",");

        let sub = this.subscriptions.get(collection);
        if (!sub) {
            if (!key) {
                return;
            }
            sub = { ids: "", chain: Promise.resolve(), off: null };
            this.subscriptions.set(collection, sub);
        }
        if (sub.ids === key) {
            return;
        }
        sub.ids = key;

        const current = sub;
        current.chain = current.chain
            .then(async () => {
                if (key !== current.ids) {
                    return; // the set changed again meanwhile: a later step has it
                }
                if (current.off) {
                    const off = current.off;
                    current.off = null;
                    await off();
                }
                if (!key || this.subscriptions.get(collection) !== current) {
                    return;
                }

                const params: { [key: string]: any } = {};
                const filter = key
                    .split(",")
                    .map((id, i) => {
                        params["id" + i] = id;
                        return "id = {:id" + i + "}";
                    })
                    .join(" || ");

                current.off = await this.client
                    .collection(collection)
                    .subscribe("*", (e) => this.onRealtime(collection, e.record), {
                        filter: this.client.filter(filter, params),
                    });

                // the set changed again, or the plugin stopped, meanwhile
                if (this.subscriptions.get(collection) !== current) {
                    const off = current.off;
                    current.off = null;
                    await off();
                }
            })
            .catch(() => {});

        if (!key) {
            this.subscriptions.delete(collection);
        }
    }

    private onRealtime(collection: string, record: RecordModel): void {
        if (!record || typeof record.id !== "string") {
            return;
        }

        for (const entry of this.entries.values()) {
            if (entry.collection !== collection || entry.id !== record.id) {
                continue;
            }
            if (!(entry.field in record)) {
                continue;
            }

            const value = record[entry.field];
            const text =
                value === null || typeof value === "undefined" ? "" : String(value);
            entry.original = text;

            if (entry.markdown) {
                // not while its editor is open, or a save is on its way
                if (!entry.surface && entry.pending === null) {
                    entry.source = text;
                    this.show(entry, text);
                }
                continue;
            }

            // not while the user is typing into it, or a save is on its way
            const focused =
                typeof document !== "undefined" && document.activeElement === entry.el;
            if (!focused && entry.pending === null && entry.el.textContent !== text) {
                entry.el.textContent = text;
            }
        }
    }
}

/**
 * The in-place editing plugin.
 *
 * ```html
 * <h1 data-vb-edit="posts:RECORD_ID:title">Hello</h1>
 * <p data-vb-edit="posts:RECORD_ID:body" data-vb-edit-multiline>...</p>
 * <article data-vb-edit="posts:RECORD_ID:content" data-vb-edit-markdown>...</article>
 * ```
 *
 * ```js
 * import PocketBase from "@voidbase-cloud/sdk";
 * import { editable } from "@voidbase-cloud/sdk/editable";
 *
 * const pb = new PocketBase("https://example.com").use(editable({ render: marked.parse }));
 * ```
 *
 * While `pb.authStore` holds a valid token, every marked element the
 * instance says the caller may write (asked once per record through
 * `GET .../records/:id/can-update`, and skipped by an instance that has no
 * such route) is contenteditable; what is typed is saved on a pause, on
 * blur and on Enter (a multiline element saves on blur only). Escape
 * reverts. The element carries `data-vb-state="saving|saved|error"` around
 * a save; a refused save reverts the text. A markdown element is swapped,
 * on focus, for a textarea with the field's source, a toolbar and, with a
 * `render`, a live preview beside it; Save (or blur) writes the source and
 * the element shows it through `render`, or as text.
 * `client.unuse("editable")` restores the elements.
 */
export function editable(
    options: EditableOptions = {},
): Plugin<{ editable: EditableController }> {
    return {
        name: "editable",
        install(client: Client) {
            const editor = new Editor(client, options);
            (client as EditableClient).editable = editor;
            editor.start();

            return () => {
                editor.stop();
                delete (client as any).editable;
            };
        },
    };
}
