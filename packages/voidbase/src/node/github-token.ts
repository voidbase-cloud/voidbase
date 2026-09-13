// One name for the GitHub token the CLI sends. The docs and the deploy say VOIDBASE_GH_TOKEN; `init --template` and
// `sync` read GH_TOKEN, so with only the documented one set a template fetch went out anonymous and, once GitHub
// rate-limited it, failed with a bare "HTTP 403". The documented name is read first; GH_TOKEN stays as the fallback,
// because it is what `gh` and most CI already export.
export const githubToken = (): string => process.env.VOIDBASE_GH_TOKEN || process.env.GH_TOKEN || "";

/** what to say when GitHub answers a status that is not the resource's own answer */
export function githubRefusal(status: number, what: string): string {
  if (status !== 403 && status !== 429) return `${what}: HTTP ${status}`;
  return githubToken()
    ? `${what}: GitHub answered HTTP ${status} to the token in VOIDBASE_GH_TOKEN (or GH_TOKEN): it may lack access, or be rate-limited`
    : `${what}: GitHub answered HTTP ${status} to an anonymous request, which is most likely its rate limit. Set VOIDBASE_GH_TOKEN to a GitHub token and try again`;
}
