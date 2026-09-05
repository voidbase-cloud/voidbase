// Minimal OIDC provider for OAuth2 tests: authorize redirects straight back with a code, token checks PKCE and
// client credentials (header or body), userinfo returns a fixed verified user.
//   bun test/mock-oidc.ts [port=5190]
const port = Number(process.argv[2] ?? 5190);
const codes = new Map<string, { challenge: string; redirectUri: string; sub: string }>();
const tokens = new Map<string, string>();
const CLIENT_ID = "voidbase-test", CLIENT_SECRET = "s3cret";
const users: Record<string, Record<string, unknown>> = {
  "1": { sub: "mock-user-1", name: "Mock User", preferred_username: "mockuser", email: "mock.user@example.com", email_verified: true, picture: `http://127.0.0.1:${port}/avatar.png` },
  "2": { sub: "mock-user-2", name: "Second Mock", preferred_username: "mock2", email: "second.mock@example.com", email_verified: false, picture: "" },
};
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (url.searchParams.get("client_id") !== CLIENT_ID || !redirectUri) return new Response("bad client", { status: 400 });
      const code = "code-" + crypto.randomUUID();
      codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri, sub: url.searchParams.get("user") ?? "1" });
      const to = new URL(redirectUri); to.searchParams.set("state", state); to.searchParams.set("code", code);
      return Response.redirect(to.toString(), 302);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      let id = form.get("client_id"), secret = form.get("client_secret");
      const basic = req.headers.get("authorization");
      if (basic?.startsWith("Basic ")) { const [u, p] = atob(basic.slice(6)).split(":"); id = decodeURIComponent(u ?? ""); secret = decodeURIComponent(p ?? ""); }
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return Response.json({ error: "invalid_client" }, { status: 401 });
      const entry = codes.get(form.get("code") ?? "");
      if (form.get("grant_type") !== "authorization_code" || !entry) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (entry.redirectUri !== form.get("redirect_uri")) return Response.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 });
      if (entry.challenge) {
        const verifier = form.get("code_verifier") ?? "";
        const expected = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
        if (expected !== entry.challenge) return Response.json({ error: "invalid_grant", error_description: "pkce" }, { status: 400 });
      }
      codes.delete(form.get("code")!);
      const access = "at-" + crypto.randomUUID(); tokens.set(access, entry.sub);
      return Response.json({ access_token: access, token_type: "Bearer", refresh_token: "rt-" + crypto.randomUUID(), expires_in: 3600, scope: "openid email profile" });
    }
    if (url.pathname === "/userinfo") {
      const sub = tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (!sub) return Response.json({ error: "invalid_token" }, { status: 401 });
      return Response.json(users[sub]);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock oidc on http://127.0.0.1:${port}`);
