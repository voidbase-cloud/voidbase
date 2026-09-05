// OAuth2 provider defaults and user-info mapping (tools/auth in PocketBase). The generic core handles any provider
// whose config carries authURL/tokenURL/userInfoURL; the entries below fill PocketBase's defaults for the common
// ones and map their user-info payloads onto AuthUser. The full 30+ provider catalog lands with auth.providers.
export interface ProviderDefaults { displayName: string; pkce: boolean; scopes: string[]; authURL?: string; tokenURL?: string; userInfoURL?: string }
export interface AuthUser { expiry: string; rawUser: Record<string, unknown>; id: string; name: string; username: string; avatarURL: string; accessToken: string; refreshToken: string; email: string }

const oidc: ProviderDefaults = { displayName: "OIDC", pkce: true, scopes: ["openid", "email", "profile"] };
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  oidc, oidc2: oidc, oidc3: oidc,
  google: { displayName: "Google", pkce: true, scopes: ["https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email"], authURL: "https://accounts.google.com/o/oauth2/v2/auth", tokenURL: "https://oauth2.googleapis.com/token", userInfoURL: "https://www.googleapis.com/oauth2/v1/userinfo" },
  github: { displayName: "GitHub", pkce: true, scopes: ["read:user", "user:email"], authURL: "https://github.com/login/oauth/authorize", tokenURL: "https://github.com/login/oauth/access_token", userInfoURL: "https://api.github.com/user" },
  discord: { displayName: "Discord", pkce: true, scopes: ["identify", "email"], authURL: "https://discord.com/oauth2/authorize", tokenURL: "https://discord.com/api/oauth2/token", userInfoURL: "https://discord.com/api/users/@me" },
  microsoft: { displayName: "Microsoft", pkce: true, scopes: ["User.Read"], authURL: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenURL: "https://login.microsoftonline.com/common/oauth2/v2.0/token", userInfoURL: "https://graph.microsoft.com/v1.0/me" },
  gitlab: { displayName: "GitLab", pkce: true, scopes: ["read_user"], authURL: "https://gitlab.com/oauth/authorize", tokenURL: "https://gitlab.com/oauth/token", userInfoURL: "https://gitlab.com/api/v4/user" },
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

// Maps a provider's raw user-info JSON onto PocketBase's AuthUser (Email only when the provider vouches for it).
export function mapAuthUser(provider: string, raw: Record<string, unknown>): Omit<AuthUser, "expiry" | "accessToken" | "refreshToken" | "rawUser"> {
  switch (provider) {
    case "google":
      return { id: str(raw.id ?? raw.sub), name: str(raw.name), username: "", avatarURL: str(raw.picture), email: truthy(raw.verified_email ?? raw.email_verified) ? str(raw.email) : "" };
    case "github":
      return { id: str(raw.id), name: str(raw.name), username: str(raw.login), avatarURL: str(raw.avatar_url), email: str(raw.email) };
    case "discord": {
      const id = str(raw.id), avatar = str(raw.avatar);
      return { id, name: str(raw.global_name || raw.username), username: str(raw.username), avatarURL: avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png` : "", email: truthy(raw.verified) ? str(raw.email) : "" };
    }
    case "microsoft":
      return { id: str(raw.id), name: str(raw.displayName), username: "", avatarURL: "", email: str(raw.mail || raw.userPrincipalName) };
    case "gitlab":
      return { id: str(raw.id), name: str(raw.name), username: str(raw.username), avatarURL: str(raw.avatar_url), email: str(raw.email) };
    default: // oidc, oidc2, oidc3 and anything unknown: standard OIDC claims
      return { id: str(raw.sub), name: str(raw.name), username: str(raw.preferred_username), avatarURL: str(raw.picture), email: truthy(raw.email_verified) ? str(raw.email) : "" };
  }
}
