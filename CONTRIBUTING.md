# Contributing

voidbase is a PocketBase-compatible backend that runs on Cloudflare Workers. It is in public beta: it works, people
are running it, and the API is PocketBase's and is not going to move. What is still moving is everything around
that, which is where help is worth the most.

If you have shipped a backend, operated one at scale, or know one of the platforms below better than we do, you are
the person this file is written for.

## Where help is worth the most

**Benchmarks.** The [comparison pages](https://voidbase.cloud/docs/why) carry performance numbers that are, by our
own admission on those pages, educated guesses. We are not qualified to benchmark a database engine and we say so.
A methodology, a harness, or a single honestly-run number against a competitor is worth more to this project than
most features. Open a discussion before you spend a weekend on it so we can agree what is being measured.

**The roadmap.** [Every item](https://voidbase.cloud/docs/roadmap) has a design and a size on it. The first half came
out of writing the comparison pages honestly, so each one is something another backend already does better. Pick one
and say so in an issue before you start, because some of them are larger than they look.

**Correctness against PocketBase.** [COMPAT.md](packages/voidbase/COMPAT.md) and
[docs/differences.md](packages/voidbase/docs/differences.md) record
where we match and where we do not. A test that proves we diverge somewhere undocumented is a good bug report, and a
better pull request.

**Cloudflare experience.** D1's limits, Durable Object placement, Workers CPU accounting, R2 lifecycle: if you know
these from production rather than from the docs, tell us where we are wrong. Several of our design decisions rest on
assumptions we have not been able to test at scale.

**Anything you tried that did not work.** A confusing error, a doc page that assumes something you did not have, a
command that failed in a way that made no sense. Small reports are welcome and are usually the fastest thing to fix.

## Getting set up

```bash
git clone https://github.com/voidbase-cloud/voidbase.git
cd voidbase
bun install          # also installs the git hooks
bun run check        # codegen + three typecheck passes
bun test             # the unit tests, about a second
```

The repository is a Bun workspace. The core package, and the Void app this repository runs to test it, is
`packages/voidbase`; a shipped plugin extracted into a package of its own is `packages/plugin-<name>`, and the core
depends on each one and loads it, so nothing about an instance changes when a plugin moves out. The root holds this
repository's own CI and release tooling (`scripts/`), the status Worker (`ci/`) and the surface map (`surface/`).
The commands above are run from the root and reach into the packages themselves. Every published package carries
one version: `bun run check` type-checks each of them, and a release packs, gates and publishes all of them
together ([docs/releasing.md](packages/voidbase/docs/releasing.md), "N packages, one version").

The app's environment file moved with the app: it is `packages/voidbase/.env`, copied from
`packages/voidbase/.env.example`. A `.env` left at the repository root from before the move is read by nothing
-- the dev server, the suites and the Worker build all run in `packages/voidbase` -- so copy it across rather
than wondering why the superuser never appears.

`bun run dev` starts the dev server. `bun run ci` runs the full suite the way CI does, which is slower and needs a
browser for the panel tests; it works out which parts your change actually affects rather than running everything.
[docs/ci.md](packages/voidbase/docs/ci.md) explains how that decision is made.

## Making a change

Commits follow [Conventional Commits](https://www.conventionalcommits.org), and this is enforced rather than
suggested: `.husky/commit-msg` runs commitlint locally and CI checks the pushed commits regardless.

```
type(scope): subject          # imperative, no trailing period, header <= 100 characters
```

`feat` and `fix` appear in the release notes and move the version; `docs`, `refactor`, `test`, `chore` and `ci` do
not. `commitlint.config.js` lists the scopes. [docs/releasing.md](packages/voidbase/docs/releasing.md) has the whole
flow, including
what merging a release pull request does.

Two things worth knowing before you open a pull request:

- **Tests come with the change.** Not for the sake of a coverage number: a test is how the next person finds out
  they broke your work. Look at what the suite near your change already does and match it.
- **Comments explain why, not what.** The code in this repository says what it does. The comments exist for the
  decisions that are not visible from the code, and the ones about PocketBase's behaviour are load-bearing, because
  matching it is the whole point.

## Reporting something

[Issues](https://github.com/voidbase-cloud/voidbase/issues) for bugs, with the version (`voidbase version`), how you
are running it, and the smallest thing that reproduces it.
[Discussions](https://github.com/voidbase-cloud/voidbase/discussions) for questions, ideas, and anything where you
are not sure yet whether it is a bug.

If you found a security problem, do not open a public issue. Use GitHub's private vulnerability reporting on the
repository (Security, then "Report a vulnerability"), which reaches the maintainers and nobody else.

## The documentation

The site and its documentation live in a separate repository,
[voidbase-cloud/voidbase-site](https://github.com/voidbase-cloud/voidbase-site), and have
[their own contributing guide](https://github.com/voidbase-cloud/voidbase-site/blob/master/CONTRIBUTING.md). Every
docs page has an "improve this page" link at the bottom that takes you straight to the file behind it.

## Licence

Contributions are made under the [MIT licence](packages/voidbase/LICENSE), the same one the project ships under.
