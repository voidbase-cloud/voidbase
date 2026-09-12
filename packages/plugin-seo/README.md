# @voidbase-cloud/plugin-seo

The seo plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It answers with
what a crawler and a link preview need, written from the records themselves: meta tags for a page, a sitemap of the
collections that opt in, and a share card rendered per record.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it — so
an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin graph.

## What it serves

| route | what it answers |
| --- | --- |
| `GET /api/seo/meta` | the tags for a path, from the record that path maps to |
| `GET /api/seo/sitemap.xml` | the collections that declared a mapping, one entry per visible record |
| `GET /api/seo/og/:collection/:id.svg` | the share card; `.png` too when `VOIDBASE_SEO_PNG=1` bundles the rasteriser |

## The two halves that stayed in the core

`@voidbase-cloud/voidbase/plugins/seo-paths` holds the knob names and the redirect lines a deploy writes, and
`@voidbase-cloud/voidbase/plugins/seo-locales` the locale maths the adapter shares with the card. Both are read by
the core itself — the deploy, the bundle, the adapter, the hooks build — so they stayed there and are published for
this package, which imports them by name.

## Swapping it

An instance loads whichever plugin claims the name `seo`: install one from a marketplace and it shadows this one,
or turn this one off in `voidbase.lock`. The knob names above stay the deploy's either way, which is why they live
where they do.

MIT
