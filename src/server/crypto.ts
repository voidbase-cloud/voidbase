// AES-GCM at rest with the key from VOIDBASE_ENCRYPTION_KEY (PocketBase's --encryptionEnv shape: 16, 24 or 32 chars).
// Used for the settings row and, through voidbase/cloud, for what a control plane must keep (OAuth tokens).
const b64 = { enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)), dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
const aesKey = (key: string) => crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/** nonce || ciphertext || tag, base64 (like PocketBase's security.Encrypt) */
export async function aesSeal(plain: string, key: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await aesKey(key), new TextEncoder().encode(plain)));
  const out = new Uint8Array(nonce.length + sealed.length); out.set(nonce); out.set(sealed, nonce.length);
  return b64.enc(out);
}
export async function aesOpen(encoded: string, key: string): Promise<string> {
  const bytes = b64.dec(encoded);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await aesKey(key), bytes.slice(12)));
}

// A secret stored in a record field: "enc:" + sealed, so a value written before a key existed still reads back.
const PREFIX = "enc:";
export const isSealed = (value: string): boolean => value.startsWith(PREFIX);
export async function sealSecret(plain: string, key: string): Promise<string> { return plain ? PREFIX + (await aesSeal(plain, key)) : ""; }
export async function openSecret(stored: string, key: string): Promise<string> {
  if (!isSealed(stored)) return stored;
  if (!key) throw new Error("the value is encrypted but VOIDBASE_ENCRYPTION_KEY is not set");
  return aesOpen(stored.slice(PREFIX.length), key);
}
