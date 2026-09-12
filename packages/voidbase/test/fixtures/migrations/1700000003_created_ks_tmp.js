/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "fields": [
      { "autogeneratePattern": "[a-z0-9]{15}", "hidden": false, "id": "text3208210256", "max": 15, "min": 15, "name": "id", "pattern": "^[a-z0-9]+$", "presentable": false, "primaryKey": true, "required": true, "system": true, "type": "text" },
      { "hidden": false, "id": "bool1547992806", "name": "flag", "presentable": false, "required": false, "system": false, "type": "bool" }
    ],
    "id": "pbc_1000000002",
    "indexes": [],
    "listRule": "",
    "name": "ks_tmp",
    "system": false,
    "type": "base"
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_1000000002");

  return app.delete(collection);
})
