// What this run is, read from the environment rather than told.
//
// Twelve-factor III says config lives in the environment and is read as *granular controls*, never as a named
// environment ("dev", "staging", "prod"): each variable answers one question, and a deploy nobody anticipated still
// behaves correctly because it answers the same questions. So nothing here asks "which environment is this?" -- it
// asks whether a build is running this, which branch it is for, which branch is production, and whether the
// credentials for a deploy are present. Every answer has a default that is right for a laptop.
//
//   WORKERS_CI_BUILD_UUID, WORKERS_CI   a Cloudflare Workers build is running this (the test scripts/ci-lib.sh makes)
//   GITHUB_ACTIONS                       a GitHub Actions run is
//   CI                                   some other automation is
//   WORKERS_CI_BRANCH, GITHUB_REF_NAME   the branch it is for; else the checkout's own
//   PRODUCTION_BRANCH                    which branch is production (default "master")
//   WRANGLER_CI_OVERRIDE_NAME            the only Worker a Cloudflare build is allowed to deploy
export interface Environment {
  /** automation of any kind, rather than a person */
  automated: boolean;
  /** a Cloudflare Workers build specifically: the only place WRANGLER_CI_OVERRIDE_NAME applies */
  cloudflareBuild: boolean;
  branch: string;
  productionBranch: string;
  /** this run is for the branch the world sees */
  production: boolean;
  /** the Worker a Cloudflare build may deploy, when it says */
  worker: string | null;
  /** one line for the log, so a build says what it read */
  describe(): string;
}

const git = (args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
};

export function environment(env: Record<string, string | undefined> = process.env): Environment {
  const cloudflareBuild = !!env.WORKERS_CI_BUILD_UUID || env.WORKERS_CI === "1";
  const automated = cloudflareBuild || env.GITHUB_ACTIONS === "true" || ["1", "true"].includes(String(env.CI ?? "").toLowerCase());
  const branch = env.WORKERS_CI_BRANCH || env.GITHUB_REF_NAME || git(["branch", "--show-current"]) || "master";
  const productionBranch = env.PRODUCTION_BRANCH || "master";
  const worker = env.WRANGLER_CI_OVERRIDE_NAME || null;
  return {
    automated, cloudflareBuild, branch, productionBranch,
    production: branch === productionBranch,
    worker,
    describe() {
      const who = cloudflareBuild ? "a Cloudflare build" : automated ? "automation" : "this machine";
      return `${who}, branch ${branch}${branch === productionBranch ? " (production)" : ` (not ${productionBranch})`}${worker ? `, worker ${worker}` : ""}`;
    },
  };
}
