// What a rebuild is, as the installer's routes and the admin panel read it (voidbase-stories, voidbase/vanilla-rebuild.feature).
//
// A vanilla instance has no repository behind it, so what its admin panel declares is what the instance is: installing,
// removing or updating a plugin changes the declaration, and a rebuild assembles the declaration as a new version of the
// instance and puts the instance onto it. A rebuild is steps, each recorded, so the panel can say which one is running
// and which one failed, and a retry resumes from the step that broke rather than from the beginning. A version is kept,
// so a plugin that breaks the instance is a rollback rather than a repair.
//
// Only the types live here: the runner is the platform's (src/node/rebuild.ts on Bun; a Worker has none yet, and says so).

export type StepName = "declare" | "fetch" | "assemble" | "upload" | "restart";

export interface RebuildStep {
  name: StepName;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  /** why it failed, or why it was skipped */
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Declared { version: string; commit: string }

export interface RebuildRun {
  id: number;
  /** what asked for it: several changes made while it waited fold into one run */
  reasons: string[];
  status: "queued" | "running" | "failed" | "done";
  steps: RebuildStep[];
  /** the version it assembled */
  version?: number;
  /** the declaration as it stood when the run read it */
  declared?: Record<string, Declared>;
  disabled?: string[];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface InstanceVersion { number: number; at: string; plugins: Record<string, Declared>; disabled: string[]; from: number | null; run: number }

export interface RebuildState { runs: RebuildRun[]; versions: InstanceVersion[]; current: number | null }

export interface Rebuilds {
  /** a change to the declaration: folds into a waiting run, or queues the next */
  queue(reason: string): RebuildRun;
  /** a change is still being made (a plugin downloading): nothing starts until the returned release is called */
  hold(): () => void;
  /** resume the failed run from the step that failed, or null when the last run did not fail */
  retry(): RebuildRun | null;
  /** put the instance back onto a version it already assembled */
  rollback(version: number): RebuildRun;
  state(): RebuildState;
}
