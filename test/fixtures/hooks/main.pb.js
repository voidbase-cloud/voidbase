/// <reference path="../pb_data/types.d.ts" />
// Fixture hooks for test/fresh-db.ts: $apis guards, $app helpers and the enrich / validate / after-error events.

routerAdd("GET", "/api/hooktest/guest", (c) => c.json(200, { ok: true }), $apis.requireGuestOnly());
routerAdd("GET", "/api/hooktest/super", (c) => c.json(200, { ok: true }), $apis.requireSuperuserAuth());

routerAdd("GET", "/api/hooktest/count", (c) => {
  return c.json(200, {
    all: $app.countRecords("ks_mig"),
    filtered: $app.countRecords("ks_mig", "title = 'counted'"),
    dbx: $app.countRecords("ks_mig", $dbx.hashExp({ title: "counted" })),
  });
});

routerAdd("GET", "/api/hooktest/admin-by-email", (c) => {
  const info = c.requestInfo();
  const admin = $app.findAuthRecordByEmail("_superusers", info.query.email);
  return c.json(200, { id: admin.id, email: admin.email() });
}, $apis.requireSuperuserAuth());

onRecordEnrich((e) => {
  // superusers keep seeing the field; everybody else gets it hidden
  if (!e.requestInfo?.auth?.isSuperuser()) {
    e.record.hide("extra");
  }
  e.next();
}, "ks_mig");

onRecordValidate((e) => {
  if (e.record.get("title") === "forbidden") {
    throw new ValidationError("title", "forbidden title");
  }
  e.next();
}, "ks_mig");

onRecordAfterCreateError((e) => {
  const coll = $app.findCollectionByNameOrId("ks_mig");
  const marker = new Record(coll, { title: "error-seen" });
  $app.save(marker);
}, "ks_mig");
