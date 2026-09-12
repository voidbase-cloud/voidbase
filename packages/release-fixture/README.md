# @voidbase-cloud/release-fixture

The second package in the workspace. It ships nothing and is never published: it exists so that the release flow is
never only exercised against a workspace of one.

It depends on `@voidbase-cloud/voidbase` through `workspace:*`, which is the shape every package extracted out of
the core will have. `test/unit/publish.test.ts` packs this directory and proves against it that

- `bun pm pack` resolves `workspace:*` to the sibling's exact version, and `npm pack` copies the protocol into the
  published manifest verbatim, where nobody can install it;
- the gate in `scripts/publish.ts` refuses the manifest npm produced;
- `publishOrder` visits `@voidbase-cloud/voidbase` before this package, whichever order it is handed them in --
  and it has to do real work to get there, since this package sorts first by path;
- a publishable package that depended on this one would be refused before anything reached npm, since the registry
  has no such name;
- `scripts/hot-release.ts` moves every workspace package to one version, this one included;
- a version bump that leaves `bun.lock` behind makes the packer resolve the *previous* release, which is why the
  release writes the lockfile's workspace versions in step and then checks what it packed.

`"private": true` is what keeps it off npm, and it is the same flag that decides what the publish loop publishes,
so the exclusion is the real rule and not a special case written for the fixture. The flag is not the only thing
standing between this directory and the registry, though: the name is in `NEVER_PUBLISH` in `scripts/publish.ts`
too, because one flag in one file is thin cover for a package that must never ship, and `npm publish --dry-run` --
the rehearsal, where a mistake like that would be noticed -- does not check `private` at all. Delete the whole
package once there are two real ones and the flow is exercised by them; deleting it before that takes the N > 1
proofs with it.

See `docs/releasing.md`, "N packages, one version".
