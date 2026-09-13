// What voidbase adds to the admin panel, as the panel's own UI extension file.
//
// The panel is PocketBase's stock build, and that build loads `/_/extensions.js` before it starts its router: the
// supported place to register pages (`app.routes.superuserOnly`) and header links (`app.store.headerLinks`), built
// with the same `t` and `store` the panel's own pages use. Every place that produces the panel's files writes this
// in place of the empty module it wrote before (src/node/panel.ts, src/adapter/panel.ts, scripts/sync-panel.ts), and
// `voidbase serve` answers it itself (src/node/assets.ts), so a panel from POCKETBASE_UI_DIST gets it too.
//
// A string rather than a file beside this one so the executable carries it with no loader: it is a plain script, so
// it holds no template literal of its own. The page is behind the panel's superuser login, and every route it calls
// checks for a superuser again.
//
// The Plugins page: what loaded and where each came from (/api/plugins), and each plugin's configuration plane
// (/api/plugins/config), editable where the instance holds it and read only where the project declares it.
//
// What the page may offer to change is read item by item from where each item came from (16.5: `source` on every
// plugin and pb_ folder): only what the instance itself holds is changed here. That is how the panel tells a vanilla
// instance, whose installer changes its own files, from an extended one, which a repository or a build declares.
export const PANEL_EXTENSIONS = String.raw`// voidbase: the admin panel's Plugins page (src/panel/extensions.ts)
(function () {
  if (typeof app === "undefined" || !app.routes || !app.store) return;
  app.store.headerLinks.splice(Math.min(2, app.store.headerLinks.length), 0, { href: "#/plugins", icon: "ri-plug-line", label: "Plugins" });

  var SOURCE = { voidbase: "Ships with voidbase", repository: "Declared in the repository", instance: "Installed on this instance" };
  var MAY = { instance: "Yes", repository: "No: change it in the repository and commit", voidbase: "No: it ships with voidbase" };

  function modeLine(installer) {
    var mode = installer && installer.mode;
    if (mode === "filesystem") return "Vanilla: this instance holds its own plugins and files, and changes to them are made here.";
    if (mode === "repository") return "Extended: the repository " + (installer.repository || "") + " declares this instance. The panel shows what it declares and changes none of it.";
    if (mode === "fixed") return "Extended: this instance was built with its plugins and files. The panel shows them and changes none of them.";
    return "The instance did not say where its plugins live, so the panel changes nothing.";
  }

  function fieldInput(name, field, spec, data, editable) {
    var id = "plugin-config-" + name + "-" + field;
    var common = { id: id, name: id, disabled: !editable };
    if (spec.type === "boolean") {
      return t.input(Object.assign(common, { type: "checkbox", className: "switch", checked: function () { return !!data.drafts[name][field]; }, onchange: function (e) { data.drafts[name][field] = e.target.checked; } }));
    }
    return t.input(Object.assign(common, {
      type: spec.type === "number" ? "number" : "text",
      value: function () { var v = data.drafts[name][field]; return v === null || v === undefined ? "" : String(v); },
      oninput: function (e) { data.drafts[name][field] = spec.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value; },
    }));
  }

  function plane(name, data, save) {
    var p = data.planes[name];
    var fields = Object.keys(p.fields);
    // changed here only on an instance that holds its own files, and only when the project does not declare it
    var extended = !data.installer || data.installer.mode !== "filesystem";
    var editable = p.editable && !extended;
    return t.div({ className: "panel m-b-base plugin-config", "data-plugin": name },
      t.div({ className: "flex gap-10 m-b-sm" },
        t.div({ className: "txt-lg" }, name),
        t.span({ className: "label" }, editable ? "Editable here" : p.editable ? "Read only: an extended instance is configured in its project" : "Read only: the project declares it in pb_plugins/" + name + "/config.json"),
      ),
      t.div({ className: "grid" }, fields.map(function (field) {
        var spec = p.fields[field];
        return t.div({ className: "col-lg-6", "data-field": field },
          t.div({ className: "field" },
            t.label({ htmlFor: "plugin-config-" + name + "-" + field }, field, " ",
              t.span({ className: "txt-hint txt-sm" }, spec.applies === "rebuild" ? "needs a rebuild" : "takes effect at once")),
            fieldInput(name, field, spec, data, editable),
          ),
          t.div({ className: "txt-sm txt-hint" },
            spec.description ? spec.description + " " : "",
            "Knob " + spec.knob + ", from " + spec.source + ".",
            spec.pending !== undefined ? t.strong({ className: "plugin-config-pending" }, " Waits for the next rebuild: " + JSON.stringify(spec.pending) + ".") : "",
          ),
        );
      })),
      editable ? t.div({ className: "flex m-t-sm" },
        t.button({ type: "button", className: "btn", disabled: function () { return data.saving === name; }, onclick: function () { save(name); } }, "Save " + name),
      ) : "",
    );
  }

  app.routes.superuserOnly("#/plugins", function () {
    app.store.title = "Plugins";
    var data = store({ loading: true, plugins: [], files: {}, installer: null, planes: {}, drafts: {}, saving: "", publicFiles: [], publicEditable: false, chosen: [], pendingSchema: [] });

    function load() {
      data.loading = true;
      return Promise.all([app.pb.send("/api/plugins", {}), app.pb.send("/api/plugins/config", {}), app.pb.send("/api/pb_public", {}), app.pb.send("/api/automigrate", {})]).then(function (answers) {
        var drafts = {};
        Object.keys(answers[1] || {}).forEach(function (name) {
          drafts[name] = {};
          Object.keys(answers[1][name].fields).forEach(function (field) { drafts[name][field] = answers[1][name].fields[field].value; });
        });
        data.plugins = answers[0].plugins || [];
        data.files = answers[0].files || {};
        data.installer = answers[0].installer || null;
        data.publicFiles = (answers[2] && answers[2].files) || [];
        data.publicEditable = !!(answers[2] && answers[2].editable === true);
        data.pendingSchema = (answers[3] && Array.isArray(answers[3].pending)) ? answers[3].pending : [];
        data.planes = answers[1] || {};
        data.drafts = drafts;
      }).catch(function (err) { app.checkApiError(err); }).finally(function () { data.loading = false; });
    }

    function save(name) {
      var fields = data.planes[name].fields, changes = {};
      Object.keys(fields).forEach(function (field) {
        var now = data.drafts[name][field], was = fields[field].value;
        if (now !== was && !(now === "" && was === null)) changes[field] = now;
      });
      if (!Object.keys(changes).length) { app.toasts.info("Nothing to save for " + name + "."); return; }
      data.saving = name;
      app.pb.send("/api/plugins/config/" + encodeURIComponent(name), { method: "PATCH", body: changes })
        .then(function (answer) { app.toasts.success(answer.message); return load(); })
        .catch(function (err) { app.checkApiError(err); })
        .finally(function () { data.saving = ""; });
    }

    function upload() {
      if (!data.chosen.length) { app.toasts.info("Choose the files to upload first."); return; }
      var form = new FormData();
      data.chosen.forEach(function (file) { form.append("files", file); });
      data.saving = "pb_public";
      app.pb.send("/api/pb_public", { method: "POST", body: form })
        .then(function (answer) { app.toasts.success(answer.message); data.chosen = []; return load(); })
        .catch(function (err) { app.checkApiError(err); })
        .finally(function () { data.saving = ""; });
    }

    load();

    return t.div({ pbEvent: "pagePlugins", className: "page" },
      t.div({ className: "page-content full-height" },
        t.header({ className: "page-header" },
          t.nav({ className: "breadcrumbs" }, t.div({ className: "breadcrumb-item" }, "Plugins")),
        ),
        t.div({ className: "wrapper m-b-base" }, function () {
          if (data.loading) return t.div({ className: "txt-hint" }, "Loading plugins...");
          return t.div(null,
            t.p({ className: "plugins-mode m-b-base" }, modeLine(data.installer)),
            data.pendingSchema.length
              ? t.div({ className: "alert alert-warning m-b-base schema-not-in-repository" },
                t.div(null, "These collection changes are not in the repository. Commit their migrations, or connect the instance to git so automigrate commits them:"),
                t.ul(null, data.pendingSchema.map(function (p) { return t.li({ "data-migration": p.file }, p.collection + " " + p.change + ": pb_migrations/" + p.file); })),
              )
              : "",
            t.div({ className: "txt-lg m-b-sm" }, "What this instance runs"),
            t.table({ className: "table m-b-base" },
              t.thead(null, t.tr(null, t.th(null, "Plugin"), t.th(null, "Tier"), t.th(null, "Where it came from"), t.th(null, "Changed here"), t.th(null, "Provides"))),
              t.tbody(null, data.plugins.map(function (p) {
                return t.tr({ "data-plugin": p.name }, t.td(null, p.name), t.td(null, p.tier), t.td(null, SOURCE[p.source] || p.source || ""), t.td(null, MAY[p.source] || "No"), t.td(null, (p.provides || []).join(", ")));
              })),
            ),
            t.div({ className: "txt-lg m-b-sm" }, "Files"),
            t.table({ className: "table m-b-base" },
              t.thead(null, t.tr(null, t.th(null, "Folder"), t.th(null, "Where it came from"), t.th(null, "Changed here"))),
              t.tbody(null, Object.keys(data.files).map(function (folder) {
                var source = data.files[folder];
                return t.tr({ "data-folder": folder }, t.td(null, folder), t.td(null, SOURCE[source] || source || ""), t.td(null, MAY[source] || "No"));
              })),
            ),
            t.div({ className: "txt-lg m-b-sm" }, "pb_public"),
            data.publicEditable
              ? t.div({ className: "flex gap-10 m-b-sm pb-public-upload" },
                t.input({ type: "file", multiple: true, className: "pb-public-files", onchange: function (e) { data.chosen = Array.prototype.slice.call(e.target.files || []); } }),
                t.button({ type: "button", className: "btn", disabled: function () { return data.saving === "pb_public"; }, onclick: upload }, "Upload to pb_public"),
              )
              : t.div({ className: "txt-hint m-b-sm" }, "These files come from the project's repository: change them there and commit."),
            t.ul({ className: "pb-public-list m-b-base" }, data.publicFiles.length
              ? data.publicFiles.map(function (f) { return t.li({ "data-public": f.path }, t.a({ href: "/" + f.path, target: "_blank", rel: "noopener noreferrer" }, f.path), " ", t.span({ className: "txt-hint" }, f.size + " bytes")); })
              : t.li({ className: "txt-hint" }, "pb_public is empty.")),
            t.div({ className: "txt-lg m-b-sm" }, "Configuration"),
            Object.keys(data.planes).length
              ? Object.keys(data.planes).map(function (name) { return plane(name, data, save); })
              : t.div({ className: "txt-hint" }, "No loaded plugin declares a configuration plane."),
          );
        }),
        t.footer({ className: "page-footer" }, app.components.credits ? app.components.credits() : ""),
      ),
    );
  });
})();
`;
