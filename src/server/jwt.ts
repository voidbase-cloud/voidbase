// HS256 JWT compatible with PocketBase tokens (header {"alg":"HS256","typ":"JWT"}).
const enc = new TextEncoder();

export function b64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export type JwtClaims = Record<string, unknown> & { exp?: number };

export async function signJWT(claims: JwtClaims, secret: string, durationSeconds: number): Promise<string> {
  // Go's jwt.MapClaims marshals keys sorted; match it so tokens diff cleanly against PocketBase.
  const unsorted: JwtClaims = { ...claims, exp: Math.floor(Date.now() / 1000) + durationSeconds };
  const payload = Object.fromEntries(Object.keys(unsorted).sort().map((k) => [k, unsorted[k]])) as JwtClaims;
  const head = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

// Decode without verifying. Returns null on malformed input.
export function decodeJWT(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!)));
  } catch {
    return null;
  }
}

/** canonical base64url without padding, as Go's RawURLEncoding decoder demands: a segment whose trailing bits are not
 * zero (a padding bit flipped) decodes to the same bytes in JavaScript but is invalid to PocketBase */
export function isCanonicalB64url(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return false;
  try { return b64urlEncode(b64urlDecode(segment)) === segment; } catch { return false; }
}

export async function verifyJWT(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  if (!isCanonicalB64url(head) || !isCanonicalB64url(body) || !isCanonicalB64url(sig)) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig), enc.encode(`${head}.${body}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  const claims = decodeJWT(token);
  if (!claims) return null;
  if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000) return null;
  return claims;
}
