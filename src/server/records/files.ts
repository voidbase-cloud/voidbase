// File naming, content sniffing, and R2 storage keyed {collectionId}/{recordId}/{filename}.
import { randomWithAlphabet } from "../ids";
import type { Upload } from "./values";

const EXT_INVALID = /[^\w.*\-+=#]+/g;

// tools/filesystem.normalizeName: snakecase(name) + "_" + random10 + ext (random part always present)
export function normalizeFilename(original: string, detectedExt: string): string {
  let name = original.length > 300 ? original.slice(-300) : original;
  const dot = name.lastIndexOf(".");
  const originalExt = dot >= 0 ? name.slice(dot) : "";
  let ext = "." + originalExt.replace(EXT_INVALID, "").replace(/^\.+|\.+$/g, "");
  if (ext === ".") ext = detectedExt || "";
  if (ext.length > 20) ext = "." + ext.slice(-20).replace(/^\.+/, "");
  let clean = snakecase((originalExt ? name.slice(0, -originalExt.length) : name).replace(/^\.+|\.+$/g, ""));
  if (clean.length < 3) clean += randomWithAlphabet(10, "abcdefghijklmnopqrstuvwxyz0123456789");
  else if (clean.length > 100) clean = clean.slice(0, 100);
  return `${clean}_${randomWithAlphabet(10, "abcdefghijklmnopqrstuvwxyz0123456789")}${ext.toLowerCase()}`;
}

export function snakecase(s: string): string {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/([a-z0-9])([A-Z])/g, "$1_$2")).join("_").toLowerCase();
}

// Minimal content sniffing for the common cases; falls back to the client's declared type.
export function sniffMime(bytes: Uint8Array, declared: string, name: string): { type: string; ext: string } {
  const b = bytes;
  const startsWith = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { type: "image/png", ext: ".png" };
  if (startsWith(0xff, 0xd8, 0xff)) return { type: "image/jpeg", ext: ".jpg" };
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return { type: "image/gif", ext: ".gif" };
  if (startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: "image/webp", ext: ".webp" };
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return { type: "application/pdf", ext: ".pdf" };
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return { type: "application/zip", ext: ".zip" };
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart();
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg/i.test(head))) return { type: "image/svg+xml", ext: ".svg" };
  if (/^\s*[{[]/.test(head)) { try { JSON.parse(new TextDecoder().decode(b)); return { type: "application/json", ext: ".json" }; } catch { /* not json */ } }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (declared && declared !== "application/octet-stream") return { type: declared.split(";")[0]!.trim(), ext };
  const isText = b.slice(0, 512).every((x) => x === 9 || x === 10 || x === 13 || (x >= 32 && x < 127) || x >= 128);
  return isText ? { type: "text/plain; charset=utf-8", ext: ext || ".txt" } : { type: "application/octet-stream", ext };
}

export const fileKey = (collectionId: string, recordId: string, filename: string) => `${collectionId}/${recordId}/${filename}`;

export async function putUpload(storage: R2Bucket, collectionId: string, recordId: string, up: Upload): Promise<void> {
  await storage.put(fileKey(collectionId, recordId, up.name), up.bytes, { httpMetadata: { contentType: up.type } });
}

export async function deleteFiles(storage: R2Bucket, collectionId: string, recordId: string, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await storage.delete(names.map((n) => fileKey(collectionId, recordId, n)));
}

export async function deleteAllRecordFiles(storage: R2Bucket, collectionId: string, recordId: string): Promise<void> {
  const listed = await storage.list({ prefix: `${collectionId}/${recordId}/` });
  if (listed.objects.length) await storage.delete(listed.objects.map((o) => o.key));
}
