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
export const PANEL_EXTENSIONS = String.raw`// voidbase: the admin panel's Plugins page (src/panel/extensions.ts)
(function () {
  if (typeof app === "undefined" || !app.routes || !app.store) return;
  app.store.headerLinks.splice(Math.min(2, app.store.headerLinks.length), 0, { href: "#/plugins", icon: "ri-plug-line", label: "Plugins" });

  var SOURCE = { voidbase: "Ships with voidbase", repository: "Declared in the repository", instance: "Installed on this instance" };

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
    return t.div({ className: "panel m-b-base plugin-config", "data-plugin": name },
      t.div({ className: "flex gap-10 m-b-sm" },
        t.div({ className: "txt-lg" }, name),
        t.span({ className: "label" }, p.editable ? "Editable here" : "Read only: the project declares it in pb_plugins/" + name + "/config.json"),
      ),
      t.div({ className: "grid" }, fields.map(function (field) {
        var spec = p.fields[field];
        return t.div({ className: "col-lg-6" },
          t.div({ className: "field" },
            t.label({ htmlFor: "plugin-config-" + name + "-" + field }, field, " ",
              t.span({ className: "txt-hint txt-sm" }, spec.applies === "rebuild" ? "needs a rebuild" : "takes effect at once")),
            fieldInput(name, field, spec, data, p.editable),
          ),
          t.div({ className: "txt-sm txt-hint" },
            spec.description ? spec.description + " " : "",
            "Knob " + spec.knob + ", from " + spec.source + ".",
            spec.pending !== undefined ? t.strong({ className: "plugin-config-pending" }, " Waits for the next rebuild: " + JSON.stringify(spec.pending) + ".") : "",
          ),
        );
      })),
      p.editable ? t.div({ className: "flex m-t-sm" },
        t.button({ type: "button", className: "btn", disabled: function () { return data.saving === name; }, onclick: function () { save(name); } }, "Save " + name),
      ) : "",
    );
  }

  app.routes.superuserOnly("#/plugins", function () {
    app.store.title = "Plugins";
    var data = store({ loading: true, plugins: [], planes: {}, drafts: {}, saving: "" });

    function load() {
      data.loading = true;
      return Promise.all([app.pb.send("/api/plugins", {}), app.pb.send("/api/plugins/config", {})]).then(function (answers) {
        var drafts = {};
        Object.keys(answers[1] || {}).forEach(function (name) {
          drafts[name] = {};
          Object.keys(answers[1][name].fields).forEach(function (field) { drafts[name][field] = answers[1][name].fields[field].value; });
        });
        data.plugins = answers[0].plugins || [];
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

    load();

    return t.div({ pbEvent: "pagePlugins", className: "page" },
      t.div({ className: "page-content full-height" },
        t.header({ className: "page-header" },
          t.nav({ className: "breadcrumbs" }, t.div({ className: "breadcrumb-item" }, "Plugins")),
        ),
        t.div({ className: "wrapper m-b-base" }, function () {
          if (data.loading) return t.div({ className: "txt-hint" }, "Loading plugins...");
          return t.div(null,
            t.div({ className: "txt-lg m-b-sm" }, "What this instance runs"),
            t.table({ className: "table m-b-base" },
              t.thead(null, t.tr(null, t.th(null, "Plugin"), t.th(null, "Tier"), t.th(null, "Where it came from"), t.th(null, "Provides"))),
              t.tbody(null, data.plugins.map(function (p) {
                return t.tr({ "data-plugin": p.name }, t.td(null, p.name), t.td(null, p.tier), t.td(null, SOURCE[p.source] || p.source || ""), t.td(null, (p.provides || []).join(", ")));
              })),
            ),
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
