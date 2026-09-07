// `bun run build`, `bun run deploy`, `bun run version`: the three verbs Cloudflare Workers Builds calls, and the
// three a person calls by hand. What each one does is read from the environment (scripts/environment.ts), so the
// same word means the right thing in a build, on a branch and on a laptop, and the dashboard holds no logic:
//
//   build     automation runs the whole CI suite (scripts/ci.sh, docs/ci.md); a person building this project gets
//             this project's own Vite build, which is what `build` means everywhere else.
//   deploy    the status page this project's Worker serves (ci/wrangler.jsonc). Off the production branch there is
//             nothing to deploy, and it says so rather than taking production's place.
//   version   the same page uploaded as a version instead of deployed: what a branch build leaves behind.
import { environment } from "./environment";

const verb = process.argv[2] ?? "";
const here = environment();
const CONFIG = ["-c", "ci/wrangler.jsonc"];
const wrangler = "./node_modules/.bin/wrangler";

const run = async (cmd: string[], what: string): Promise<never> => {
  console.log(`[${verb}] ${what} — ${here.describe()}`);
  process.exit(await Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" }).exited);
};
const skip = (why: string): never => { console.log(`[${verb}] nothing to do: ${why} — ${here.describe()}`); process.exit(0); };

switch (verb) {
  case "build":
    await run(here.automated ? ["bash", "scripts/ci.sh"] : ["./node_modules/.bin/vp", "build"], here.automated ? "the CI suite" : "this project's Vite build");
    break;
  case "deploy":
    if (!here.production) skip(`${here.branch} is not ${here.productionBranch}`);
    await run([wrangler, "deploy", ...CONFIG], "the CI status page");
    break;
  case "version":
    await run([wrangler, "versions", "upload", ...CONFIG], "the CI status page, as a version");
    break;
  default:
    console.error("usage: bun run build | bun run deploy | bun run version");
    process.exit(2);
}
