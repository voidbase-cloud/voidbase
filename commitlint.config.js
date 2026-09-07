// Conventional Commits (https://www.conventionalcommits.org): `type(scope): subject`, enforced by .husky/commit-msg
// locally and by the commitlint job in ci.yml. release-please compiles them into CHANGELOG.md and the GitHub
// release notes: feat -> Features, fix -> Bug Fixes, perf -> Performance, revert, docs, refactor; `feat!:` or a
// "BREAKING CHANGE:" footer bumps the minor while the version is below 1.0 (docs/releasing.md).
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert", "style"]],
    // a warning, not an error: the scopes are the areas of the code base, extend the list when a new one appears
    "scope-enum": [1, "always", ["server", "records", "collections", "auth", "oauth2", "realtime", "hub", "jobs", "mail", "files", "hooks", "migrations", "settings", "logs", "crons", "backups", "hardening", "deploy", "cloud", "bundle", "cli", "serve", "plugin", "adapter", "panel", "docs", "ci", "release", "deps", "test", "site", "starter"]],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [1, "always", 120],
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],
  },
};
