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

// --- request-level and model-level hooks (checked by test/fresh-db.ts) ---------------------------

onCollectionCreateRequest((e) => {
  if (e.collection.name === "ks_hookfail") {
    throw new BadRequestError("hook refused.");
  }
  e.next();
});

onCollectionAfterCreateSuccess((e) => {
  const coll = $app.findCollectionByNameOrId("ks_mig");
  const marker = new Record(coll, { title: "collection-created" });
  $app.save(marker);
}, "ks_hooked");

onSettingsListRequest((e) => {
  e.settings.meta.hideControls = true;
  e.next();
});

onRecordAuthWithPasswordRequest((e) => {
  if (e.identity === "blocked@example.com") {
    throw new ForbiddenError("blocked by hook.");
  }
  e.next();
});

onRecordsListRequest((e) => {
  e.next();
  // post-processing after e.next(): hooks see the computed result
  e.result.hooked = true;
}, "ks_mig");

cronAdd("hookjob", "*/5 * * * *", () => {
  const coll = $app.findCollectionByNameOrId("ks_mig");
  const marker = new Record(coll, { title: "cron-ran" });
  $app.save(marker);
});

// unhandled (non-ApiError) exception from a hook route: answered as a generic 500 and reported through the alert webhook
routerAdd("GET", "/api/hooktest/boom", () => {
  throw new Error("boom");
});
