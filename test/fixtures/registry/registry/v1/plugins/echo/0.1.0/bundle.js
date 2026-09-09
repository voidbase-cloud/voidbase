// A plugin bundle as a marketplace serves it: one ES module whose default export is the plugin, importing nothing
// the instance does not provide. This one imports nothing at all. It is the reference an instance is tested against.
const manifest = { name: "echo", version: "0.1.0", tier: "community", voidbase: "*" };
const plugin = {
  manifest,
  apply(ctx) {
    ctx.app.get("/api/echo", (c) => c.text("echo"));
  },
};
export { plugin };
export default plugin;
