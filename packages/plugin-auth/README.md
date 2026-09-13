# @voidbase-cloud/plugin-auth

The auth plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It provides
`auth@1`: who is making a request, what a superuser is, which collections hold accounts, and the routes that sign
people in (password, OAuth2, OTP, MFA and passkeys).

It is a tier 1 plugin (decision 9): core defines `auth@1` and loads this plugin by default, and another plugin
providing `auth@1` can take its place. `@voidbase-cloud/voidbase` depends on this package and loads it, so an instance
needs nothing here.

## The shape

- **It is the seam, not the implementation.** The sign-in flows themselves are the core's, published to this plugin
  as `@voidbase-cloud/voidbase/auth-routes`; what this package holds is the plugin that mounts them and answers the
  questions the core asks through `/auth-slot`.
- **It imports the core by name and only by name**: `/auth-routes`, `/sdk`, `/types`, `/interfaces`, `/kernel`,
  `/record-slot` and `/plugins`, plus `hono` at the core's own range.
- **`@voidbase-cloud/voidbase/plugins/auth` stays published**, as a re-export of this package.
- **npm is the only registry this name is published to from here.** The standalone `voidbase-plugin-auth`
  repository publishes the same name to GitHub Packages until it is archived (11.4), which is why the release never
  mirrors `@voidbase-cloud/plugin-*` there.

The rest of the shape is the template `packages/plugin-realtime/README.md` describes, and
`packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every `@voidbase-cloud/plugin-*` package.

## Licence

MIT, with voidbase.
