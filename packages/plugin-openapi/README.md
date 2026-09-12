# @voidbase-cloud/plugin-openapi

The openapi plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It writes the
instance's own OpenAPI document from the collections that exist on it, and serves the reference that renders it.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it — so
an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin graph.

## What it serves

| route | what it answers |
| --- | --- |
| `GET /api/openapi.json` | the document for the caller: the collections they may see, with the fields they may read |
| `GET /api/docs` | the reference, rendered from that document |

The document is built per request rather than kept, because what a caller may see decides what is in it: an
anonymous caller, a user and a superuser are three different documents of the same instance.

## What else reads it

This package is also where the two plugins that describe the instance to a machine get their description:
`@voidbase-cloud/plugin-mcp` turns the document into MCP tools, and `@voidbase-cloud/plugin-ai` answers questions
about the instance with them. They depend on this package by name rather than through the core, because that is
what they actually use.

## Swapping it

An instance loads whichever plugin claims the name `openapi`: install one from a marketplace and it shadows this
one, or turn this one off in `voidbase.lock`. Nothing else in the instance changes — the plugins that read the
document ask for the interface, not for this package.

MIT
