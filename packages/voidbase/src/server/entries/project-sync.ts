// `@voidbase-cloud/voidbase/project-sync`: a project's plugins changed by one commit, for the installer.
//
// plugins/installer.ts reads the lockfile of the repository an instance was deployed from (`lockOf`), writes the
// change back as one commit (`commitPlugins`), and names the file in what it reports (`LOCKFILE`). The types those
// take and return come with them. The rest of ../project-sync.ts is how a lockfile is parsed and printed, which
// the core does for itself on both sides of that commit.
export { LOCKFILE, commitPlugins, lockOf, type Committed, type Lock, type LockEntry, type PluginChange, type Repo } from "../project-sync";
