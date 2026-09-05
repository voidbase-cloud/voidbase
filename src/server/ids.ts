const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const STRING_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomWithAlphabet(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

// PocketBase record ids: 15 chars of [a-z0-9].
export const randomId = () => randomWithAlphabet(15, ID_ALPHABET);
// PocketBase security.RandomString: [a-zA-Z0-9]. Used for token secrets (50) and tokenKey (50).
export const randomString = (length: number) => randomWithAlphabet(length, STRING_ALPHABET);

// PocketBase datetime format: "2006-01-02 15:04:05.000Z"
export function nowString(d = new Date()): string {
  return d.toISOString().replace("T", " ");
}

// PocketBase appends a 10-char pseudorandom suffix to auto-generated index names.
export const randomIdSuffix = () => randomWithAlphabet(10, ID_ALPHABET);
