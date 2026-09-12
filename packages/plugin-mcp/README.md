# @voidbase-cloud/plugin-mcp

The mcp plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It makes the
instance an MCP server: the tools it offers are written from the instance's own OpenAPI document, so they are the
collections that exist, with the fields the caller may read.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it — so
an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin graph.

## What it serves

`POST /api/mcp` takes one JSON-RPC request at a time and answers it. The transport is stateless on purpose: a
Worker isolate is not a session, so there is no session id to keep and every request carries what it needs.

## Why it depends on `@voidbase-cloud/plugin-openapi`

The tools are the document. This package reads `buildDocument` and `callerOf` from the openapi package by name,
rather than through `@voidbase-cloud/voidbase/plugins/openapi`, because the openapi package is what it uses — going
through the core's re-export would put a module of the core in this package's closure for nothing.

That makes the two a chain the release honours: the openapi package is published, and resolvable, before this one.

## Swapping it

An instance loads whichever plugin claims the name `mcp`: install one from a marketplace and it shadows this one,
or turn this one off in `voidbase.lock`.

MIT
