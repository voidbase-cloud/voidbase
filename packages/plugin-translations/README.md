# @voidbase-cloud/plugin-translations

The translations plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. A field
is declared translatable once and the records API answers in the locale the request asks for. Two knobs declare
everything:

```
VOIDBASE_TRANSLATABLE=posts:title,body;pages:title   which fields of which collections have translations
VOIDBASE_LOCALES=en,ar,fr                            the locales; the first is the source, the order the fallback
```

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

- **It owns a collection**, `translations`, one row per (collection, record, field, locale) — the first extracted
  plugin that does. A manifest names the collections a plugin owns so two plugins claiming one name collide at
  install rather than at boot, and owning one means creating it: the plugin asks for it at bootstrap through
  `ensureCollections`, published as `@voidbase-cloud/voidbase/plugins/collections`. That is the same entry a
  marketplace plugin uses, so this package declares its schema exactly the way a third-party one does.
- **Reading goes through the kernel's after-read seam.** `onAfterRead` hands over the rows as the response will
  carry them — after the rules judged the read and `expand` and `fields` were applied — so a translation is only
  ever shown on a record the caller could already see. The source text stays in the record's own field: writes
  never touch this plugin, and realtime events carry the record as stored.
- **It imports the core by name and only by name**: `/platform` (`env` and `logger`), `/sdk`, `/kernel`, `/types`,
  `/plugins/collections`, `/plugins`, and `hono` for its routes.
- **`@voidbase-cloud/voidbase/plugins/translations` stays published forever**, as a re-export of this package.

The rest of the shape — the lockstep version, the peer edge back on the core, npm as the only registry this name is
published to — is the template `packages/plugin-realtime/README.md` describes, and
`packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every `@voidbase-cloud/plugin-*` package in
the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
