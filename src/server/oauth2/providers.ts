// OAuth2 provider catalog (PocketBase tools/auth): endpoints, scopes, PKCE defaults and the user-info fetch and
// mapping for every provider PocketBase ships. Email is only taken when the provider vouches for it.
export interface ProviderDefaults { displayName: string; pkce: boolean; scopes: string[]; authURL?: string; tokenURL?: string; userInfoURL?: string }
export interface AuthUser { expiry: string; rawUser: Record<string, unknown>; id: string; name: string; username: string; avatarURL: string; accessToken: string; refreshToken: string; email: string }
export interface Token { access_token: string; token_type?: string; refresh_token?: string; expires_in?: number; id_token?: string; [k: string]: unknown }
export interface ProviderContext { name: string; clientId: string; clientSecret: string; userInfoURL: string; extra: Record<string, unknown> }
type Raw = Record<string, unknown>;

const oidc: ProviderDefaults = { displayName: "OIDC", pkce: true, scopes: ["openid", "email", "profile"] };
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  oidc, oidc2: oidc, oidc3: oidc,
  apple: { displayName: "Apple", pkce: true, scopes: ["name", "email"], authURL: "https://appleid.apple.com/auth/authorize", tokenURL: "https://appleid.apple.com/auth/token" },
  bitbucket: { displayName: "Bitbucket", pkce: false, scopes: ["account"], authURL: "https://bitbucket.org/site/oauth2/authorize", tokenURL: "https://bitbucket.org/site/oauth2/access_token", userInfoURL: "https://api.bitbucket.org/2.0/user" },
  box: { displayName: "Box", pkce: true, scopes: ["root_readonly"], authURL: "https://account.box.com/api/oauth2/authorize", tokenURL: "https://api.box.com/oauth2/token", userInfoURL: "https://api.box.com/2.0/users/me" },
  discord: { displayName: "Discord", pkce: true, scopes: ["identify", "email"], authURL: "https://discord.com/api/oauth2/authorize", tokenURL: "https://discord.com/api/oauth2/token", userInfoURL: "https://discord.com/api/users/@me" },
  facebook: { displayName: "Facebook", pkce: true, scopes: ["email"], authURL: "https://www.facebook.com/v3.2/dialog/oauth", tokenURL: "https://graph.facebook.com/v3.2/oauth/access_token", userInfoURL: "https://graph.facebook.com/me?fields=name,email,picture.type(large)" },
  gitea: { displayName: "Gitea/Forgejo", pkce: true, scopes: ["read:user", "user:email"], authURL: "https://gitea.com/login/oauth/authorize", tokenURL: "https://gitea.com/login/oauth/access_token", userInfoURL: "https://gitea.com/api/v1/user" },
  gitee: { displayName: "Gitee", pkce: true, scopes: ["user_info", "emails"], authURL: "https://gitee.com/oauth/authorize", tokenURL: "https://gitee.com/oauth/token", userInfoURL: "https://gitee.com/api/v5/user" },
  github: { displayName: "GitHub", pkce: true, scopes: ["read:user", "user:email"], authURL: "https://github.com/login/oauth/authorize", tokenURL: "https://github.com/login/oauth/access_token", userInfoURL: "https://api.github.com/user" },
  gitlab: { displayName: "GitLab", pkce: true, scopes: ["read_user"], authURL: "https://gitlab.com/oauth/authorize", tokenURL: "https://gitlab.com/oauth/token", userInfoURL: "https://gitlab.com/api/v4/user" },
  google: { displayName: "Google", pkce: true, scopes: ["https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email"], authURL: "https://accounts.google.com/o/oauth2/v2/auth", tokenURL: "https://oauth2.googleapis.com/token", userInfoURL: "https://www.googleapis.com/oauth2/v3/userinfo" },
  instagram: { displayName: "Instagram", pkce: true, scopes: ["instagram_business_basic"], authURL: "https://www.instagram.com/oauth/authorize", tokenURL: "https://api.instagram.com/oauth/access_token", userInfoURL: "https://graph.instagram.com/me?fields=id,username,account_type,user_id,name,profile_picture_url,followers_count,follows_count,media_count" },
  kakao: { displayName: "Kakao", pkce: true, scopes: ["account_email", "profile_nickname", "profile_image"], authURL: "https://kauth.kakao.com/oauth/authorize", tokenURL: "https://kauth.kakao.com/oauth/token", userInfoURL: "https://kapi.kakao.com/v2/user/me" },
  lark: { displayName: "Lark", pkce: true, scopes: [], authURL: "https://accounts.feishu.cn/open-apis/authen/v1/authorize", tokenURL: "https://open.feishu.cn/open-apis/authen/v2/oauth/token", userInfoURL: "https://open.feishu.cn/open-apis/authen/v1/user_info" },
  linear: { displayName: "Linear", pkce: false, scopes: ["read"], authURL: "https://linear.app/oauth/authorize", tokenURL: "https://api.linear.app/oauth/token", userInfoURL: "https://api.linear.app/graphql" },
  livechat: { displayName: "LiveChat", pkce: true, scopes: [], authURL: "https://accounts.livechat.com/", tokenURL: "https://accounts.livechat.com/token", userInfoURL: "https://accounts.livechat.com/v2/accounts/me" },
  mailcow: { displayName: "mailcow", pkce: true, scopes: ["profile"] },
  microsoft: { displayName: "Microsoft", pkce: true, scopes: ["User.Read"], authURL: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenURL: "https://login.microsoftonline.com/common/oauth2/v2.0/token", userInfoURL: "https://graph.microsoft.com/v1.0/me" },
  monday: { displayName: "monday.com", pkce: true, scopes: ["me:read"], authURL: "https://auth.monday.com/oauth2/authorize", tokenURL: "https://auth.monday.com/oauth2/token", userInfoURL: "https://api.monday.com/v2" },
  notion: { displayName: "Notion", pkce: true, scopes: [], authURL: "https://api.notion.com/v1/oauth/authorize", tokenURL: "https://api.notion.com/v1/oauth/token", userInfoURL: "https://api.notion.com/v1/users/me" },
  patreon: { displayName: "Patreon", pkce: true, scopes: ["identity", "identity[email]"], authURL: "https://www.patreon.com/oauth2/authorize", tokenURL: "https://www.patreon.com/api/oauth2/token", userInfoURL: "https://www.patreon.com/api/oauth2/v2/identity?fields%5Buser%5D=full_name,email,vanity,image_url,is_email_verified" },
  planningcenter: { displayName: "Planning Center", pkce: true, scopes: ["people"], authURL: "https://api.planningcenteronline.com/oauth/authorize", tokenURL: "https://api.planningcenteronline.com/oauth/token", userInfoURL: "https://api.planningcenteronline.com/people/v2/me" },
  spotify: { displayName: "Spotify", pkce: true, scopes: ["user-read-private"], authURL: "https://accounts.spotify.com/authorize", tokenURL: "https://accounts.spotify.com/api/token", userInfoURL: "https://api.spotify.com/v1/me" },
  strava: { displayName: "Strava", pkce: true, scopes: ["profile:read_all"], authURL: "https://www.strava.com/oauth/authorize", tokenURL: "https://www.strava.com/api/v3/oauth/token", userInfoURL: "https://www.strava.com/api/v3/athlete" },
  trakt: { displayName: "Trakt", pkce: true, scopes: [], authURL: "https://trakt.tv/oauth/authorize", tokenURL: "https://api.trakt.tv/oauth/token", userInfoURL: "https://api.trakt.tv/users/settings" },
  twitch: { displayName: "Twitch", pkce: true, scopes: ["user:read:email"], authURL: "https://id.twitch.tv/oauth2/authorize", tokenURL: "https://id.twitch.tv/oauth2/token", userInfoURL: "https://api.twitch.tv/helix/users" },
  twitter: { displayName: "X/Twitter", pkce: true, scopes: ["users.read", "users.email", "tweet.read"], authURL: "https://x.com/i/oauth2/authorize", tokenURL: "https://api.x.com/2/oauth2/token", userInfoURL: "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url,confirmed_email" },
  vk: { displayName: "ВКонтакте", pkce: false, scopes: ["email"], authURL: "https://oauth.vk.com/authorize", tokenURL: "https://oauth.vk.com/access_token", userInfoURL: "https://api.vk.com/method/users.get?fields=photo_max,screen_name&v=5.131" },
  wakatime: { displayName: "WakaTime", pkce: true, scopes: ["email"], authURL: "https://wakatime.com/oauth/authorize", tokenURL: "https://wakatime.com/oauth/token", userInfoURL: "https://wakatime.com/api/v1/users/current" },
  yandex: { displayName: "Yandex", pkce: true, scopes: ["login:email", "login:avatar", "login:info"], authURL: "https://oauth.yandex.com/authorize", tokenURL: "https://oauth.yandex.com/token", userInfoURL: "https://login.yandex.ru/info" },
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Raw)[k] : undefined), o);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const jwtClaims = (jwt: string): Raw => { try { const p = jwt.split(".")[1] ?? ""; return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(p.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0)))) as Raw; } catch { return {}; } };

async function getJSON(url: string, token: Token, headers: Record<string, string> = {}): Promise<Raw> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json", ...headers } });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`failed to fetch OAuth2 user profile via ${url} (${res.status}):\n${text}`);
  return JSON.parse(text) as Raw;
}
async function graphQL(url: string, token: Token, query: string, headers: Record<string, string> = {}): Promise<Raw> {
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify({ query }) });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`failed to fetch OAuth2 user profile via ${url} (${res.status}):\n${text}`);
  return JSON.parse(text) as Raw;
}

// the raw user-info document (most providers: GET userInfoURL with the bearer token)
export async function fetchRawUser(p: ProviderContext, token: Token): Promise<Raw> {
  switch (p.name) {
    case "apple": case "oidc": case "oidc2": case "oidc3": case "mailcow":
      if (p.userInfoURL) return getJSON(p.userInfoURL, token);
      if (!token.id_token) throw new Error("empty id_token");
      return jwtClaims(String(token.id_token));
    case "linear": return graphQL(p.userInfoURL, token, "query { viewer { id displayName name email avatarUrl active } }");
    case "monday": return graphQL(p.userInfoURL, token, "query { me { id enabled name email is_verified photo_small } }");
    case "twitch": return getJSON(p.userInfoURL, token, { "Client-Id": p.clientId });
    case "trakt": return getJSON(p.userInfoURL, token, { "trakt-api-key": p.clientId, "trakt-api-version": "2" });
    case "notion": return getJSON(p.userInfoURL, token, { "Notion-Version": "2022-06-28" });
    default:
      if (!p.userInfoURL) throw new Error("missing userInfoURL");
      return getJSON(p.userInfoURL, token);
  }
}

// providers whose verified email lives on a second endpoint
async function extraEmail(p: ProviderContext, token: Token): Promise<string> {
  const pick = (list: unknown, ok: (e: Raw) => boolean, key = "email") => { for (const e of (Array.isArray(list) ? list : []) as Raw[]) if (ok(e)) return str(e[key]); return ""; };
  try {
    switch (p.name) {
      case "github": return pick(await getJSON(`${p.userInfoURL}/emails`, token), (e) => truthy(e.primary) && truthy(e.verified));
      case "gitea": return pick(await getJSON(`${p.userInfoURL}/emails`, token), (e) => truthy(e.primary) && truthy(e.verified));
      case "gitee": return pick(await getJSON(p.userInfoURL.replace(/\/user$/, "/emails"), token), (e) => (Array.isArray(e.scope) ? (e.scope as string[]).includes("primary") : truthy(e.primary)) && (e.state === "confirmed" || truthy(e.confirmed)));
      case "bitbucket": return pick(get(await getJSON(`${p.userInfoURL}/emails`, token), "values"), (e) => truthy(e.is_primary) && truthy(e.is_confirmed));
      default: return "";
    }
  } catch { return ""; }
}

export async function fetchProviderUser(p: ProviderContext, token: Token): Promise<AuthUser> {
  const raw = await fetchRawUser(p, token);
  const u = mapUser(p, raw, token);
  if (!u.email && ["github", "gitea", "gitee", "bitbucket"].includes(p.name)) u.email = await extraEmail(p, token);
  const expiry = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;
  return { ...u, rawUser: raw, accessToken: token.access_token, refreshToken: str(token.refresh_token), expiry: expiry ? expiry.toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ".$1Z") : "" };
}

// tools/auth/<provider>.go FetchAuthUser mappings
export function mapUser(p: ProviderContext, raw: Raw, token: Token): Omit<AuthUser, "expiry" | "accessToken" | "refreshToken" | "rawUser"> {
  const base = { id: "", name: "", username: "", avatarURL: "", email: "" };
  switch (p.name) {
    case "google": return { ...base, id: str(raw.sub), name: str(raw.name), avatarURL: str(raw.picture), email: truthy(raw.email_verified) ? str(raw.email) : "" };
    case "apple": return { ...base, id: str(raw.sub), name: str(raw.name), email: truthy(raw.email_verified) ? str(raw.email) : "" };
    case "bitbucket": if (raw.account_status !== "active") throw new Error("Bitbucket user account is not active"); return { ...base, id: str(raw.uuid), name: str(raw.display_name), username: str(raw.username), avatarURL: str(get(raw, "links", "avatar", "href")) };
    case "box": if (raw.status !== "active") throw new Error(`Box user account is not active (status: ${str(raw.status)})`); return { ...base, id: str(raw.id), name: str(raw.name), avatarURL: str(raw.avatar_url), email: str(raw.login) };
    case "discord": {
      const id = str(raw.id); let name = str(raw.global_name) || str(raw.username);
      const disc = str(raw.discriminator); if (!raw.global_name && disc && disc !== "0") name += "#" + disc;
      return { ...base, id, name, username: str(raw.username), avatarURL: raw.avatar ? `https://cdn.discordapp.com/avatars/${id}/${str(raw.avatar)}.png` : "", email: truthy(raw.verified) ? str(raw.email) : "" };
    }
    case "facebook": return { ...base, id: str(raw.id), name: str(raw.name), email: str(raw.email), avatarURL: str(get(raw, "picture", "data", "url")) };
    case "gitea": if (!truthy(raw.active)) throw new Error("the Gitea user is not active"); return { ...base, id: str(raw.id), name: str(raw.full_name), username: str(raw.login), avatarURL: str(raw.avatar_url) };
    case "gitee": return { ...base, id: str(raw.id), name: str(raw.name), username: str(raw.login), avatarURL: str(raw.avatar_url), email: raw.email && isEmail(str(raw.email)) ? str(raw.email) : "" };
    case "github": return { ...base, id: str(raw.id), name: str(raw.name), username: str(raw.login), avatarURL: str(raw.avatar_url) };
    case "gitlab": return { ...base, id: str(raw.id), name: str(raw.name), username: str(raw.username), avatarURL: str(raw.avatar_url), email: raw.confirmed_at && !Number.isNaN(Date.parse(str(raw.confirmed_at))) ? str(raw.email) : "" };
    case "instagram": return { ...base, id: str(raw.user_id), name: str(raw.name), username: str(raw.username), avatarURL: str(raw.profile_picture_url) };
    case "kakao": { const acc = (raw.kakao_account ?? {}) as Raw; return { ...base, id: str(raw.id), username: str(get(raw, "properties", "nickname")), avatarURL: str(get(raw, "properties", "profile_image")), email: truthy(acc.is_email_valid) && truthy(acc.is_email_verified) ? str(acc.email) : "" }; }
    case "lark": return { ...base, id: str(get(raw, "data", "union_id")), name: str(get(raw, "data", "name")), avatarURL: str(get(raw, "data", "avatar_url")) };
    case "linear": { const v = (get(raw, "data", "viewer") ?? {}) as Raw; if (!truthy(v.active)) throw new Error("the Linear user is not active"); return { ...base, id: str(v.id), name: str(v.name), username: str(v.displayName), email: str(v.email), avatarURL: str(v.avatarUrl) }; }
    case "livechat": return { ...base, id: str(raw.account_id), name: str(raw.name), avatarURL: str(raw.avatar_url), email: truthy(raw.email_verified) ? str(raw.email) : "" };
    case "mailcow": { if (Number(raw.active) !== 1) throw new Error("the mailcow user is not active"); const username = str(raw.username); return { ...base, id: str(raw.id), name: str(raw.full_name), username: username.includes("@") ? username.split("@")[0]! : username, email: str(raw.email) }; }
    case "microsoft": { const claims = token.id_token ? jwtClaims(String(token.id_token)) : {}; return { ...base, id: str(raw.id), name: str(raw.displayName), email: str(claims.email) || str(raw.mail) }; }
    case "monday": { const me = (get(raw, "data", "me") ?? {}) as Raw; if (!truthy(me.enabled)) throw new Error("the monday.com user is not enabled"); return { ...base, id: str(me.id), name: str(me.name), avatarURL: str(me.photo_small), email: truthy(me.is_verified) ? str(me.email) : "" }; }
    case "notion": { const u = (get(raw, "bot", "owner", "user") ?? {}) as Raw; return { ...base, id: str(u.id), name: str(u.name), email: str(get(u, "person", "email")), avatarURL: str(u.avatar_url) }; }
    case "patreon": { const a = (get(raw, "data", "attributes") ?? {}) as Raw; return { ...base, id: str(get(raw, "data", "id")), username: str(a.vanity), name: str(a.full_name), avatarURL: str(a.image_url), email: truthy(a.is_email_verified) ? str(a.email) : "" }; }
    case "planningcenter": { const a = (get(raw, "data", "attributes") ?? {}) as Raw; if (a.status !== "active") throw new Error("the Planning Center user is not active"); return { ...base, id: str(get(raw, "data", "id")), name: str(a.name), avatarURL: str(a.avatar) }; }
    case "spotify": { const images = Array.isArray(raw.images) ? (raw.images as Raw[]) : []; return { ...base, id: str(raw.id), name: str(raw.display_name), avatarURL: str(images[0]?.url) }; }
    case "strava": return { ...base, id: raw.id ? str(raw.id) : "", name: `${str(raw.firstname)} ${str(raw.lastname)}`, username: str(raw.username), avatarURL: str(raw.profile) };
    case "trakt": { const u = (raw.user ?? {}) as Raw; return { ...base, id: str(get(u, "ids", "uuid")), username: str(u.username), name: str(u.name), avatarURL: str(get(u, "images", "avatar", "full")) }; }
    case "twitch": { const d = (Array.isArray(raw.data) ? (raw.data as Raw[])[0] : undefined); if (!d) throw new Error("failed to fetch Twitch user"); return { ...base, id: str(d.id), name: str(d.display_name), username: str(d.login), email: str(d.email), avatarURL: str(d.profile_image_url) }; }
    case "twitter": { const d = (raw.data ?? {}) as Raw; return { ...base, id: str(d.id), name: str(d.name), username: str(d.username), email: str(d.confirmed_email), avatarURL: str(d.profile_image_url) }; }
    case "vk": { const r = (Array.isArray(raw.response) ? (raw.response as Raw[])[0] : undefined); if (!r) throw new Error("failed to fetch VK user"); return { ...base, id: str(r.id), name: `${str(r.first_name)} ${str(r.last_name)}`.trim(), username: str(r.screen_name), avatarURL: str(r.photo_max), email: token.email ? str(token.email) : "" }; }
    case "wakatime": { const d = (raw.data ?? {}) as Raw; return { ...base, id: str(d.id), name: str(d.display_name), username: str(d.username), email: truthy(d.is_email_confirmed) ? str(d.email) : "", avatarURL: truthy(d.photo_public) ? str(d.photo) : "" }; }
    case "yandex": return { ...base, id: str(raw.id), name: str(raw.real_name), username: str(raw.login), email: str(raw.default_email), avatarURL: !truthy(raw.is_avatar_empty) && raw.default_avatar_id ? `https://avatars.yandex.net/get-yapic/${str(raw.default_avatar_id)}/islands-200` : "" };
    default: return { ...base, id: str(raw.sub), name: str(raw.name), username: str(raw.preferred_username), avatarURL: str(raw.picture), email: truthy(raw.email_verified) ? str(raw.email) : "" }; // oidc
  }
}
