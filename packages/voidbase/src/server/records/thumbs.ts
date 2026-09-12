// Thumbnails, mirroring PocketBase's apis/file.go + tools/filesystem CreateThumb (disintegration/imaging semantics):
// WxH fill+crop (center), WxHt (top), WxHb (bottom), WxHf fit without upscaling, 0xH / Wx0 resize by one side.
// Only sizes declared on the field (plus the default 100x100) are honoured; anything else, a non-image original
// or a failed generation serves the original, exactly like PocketBase. Generated thumbs are cached in R2 under
// {collection}/{record}/thumbs_{filename}/{size}_{filename}. Resizing runs in Photon (Rust -> wasm).
import type { PhotonImage as PhotonImageT } from "#platform/photon";
// Photon (Rust -> wasm) is loaded on the first thumbnail so every other request keeps a small cold start
let photonModule: Promise<typeof import("#platform/photon")> | null = null;
const photon = () => (photonModule ??= import("#platform/photon"));
let P: Awaited<ReturnType<typeof photon>>; // set by createThumb before the helpers below run
type PhotonImage = PhotonImageT;

export const THUMB_SIZE_RE = /^(\d+)x(\d+)(t|b|f)?$/;
export const IMAGE_CONTENT_TYPES = ["image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp"];
export const DEFAULT_THUMB_SIZES = ["100x100"];

export interface ByteRange { offset: number; length: number }
export interface ServedFile { body: ReadableStream | Uint8Array; size: number; contentType: string; uploaded: Date; name: string; range?: ByteRange }

// Parses a single `Range: bytes=a-b` header against the total size; null when absent, "invalid" when unsatisfiable.
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number, end: number;
  if (m[1] === "") { const suffix = Number(m[2]); if (suffix <= 0) return "invalid"; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2])); }
  if (start >= size || start > end) return "invalid";
  return { offset: start, length: end - start + 1 };
}

const attrsOf = (h: R2Object | null) => ({ size: h?.size ?? 0, type: h?.httpMetadata?.contentType ?? "application/octet-stream" });
const sliceRange = (bytes: Uint8Array, range: ByteRange | undefined) => range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;

async function getObject(storage: R2Bucket, key: string, rangeHeader: string | undefined): Promise<{ obj: R2ObjectBody; range?: ByteRange } | null | "invalid"> {
  const head = rangeHeader ? await storage.head(key) : null;
  if (rangeHeader && !head) return null;
  const range = rangeHeader ? parseRange(rangeHeader, head!.size) : null;
  if (range === "invalid") return "invalid";
  const obj = await storage.get(key, range ? { range } : undefined);
  if (!obj) return null;
  return { obj, range: range ?? undefined };
}

const served = (obj: R2ObjectBody, name: string, fallbackType: string, range?: ByteRange): ServedFile =>
  ({ body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType ?? fallbackType, uploaded: obj.uploaded, name, range });

export class RangeNotSatisfiable extends Error { constructor(public size: number, public contentType: string, public name: string) { super("range not satisfiable"); } }

export async function resolveServedFile(storage: R2Bucket, key: string, filename: string, thumbSize: string, fieldThumbs: string[], rangeHeader?: string): Promise<ServedFile | null> {
  if (thumbSize && (DEFAULT_THUMB_SIZES.includes(thumbSize) || fieldThumbs.includes(thumbSize))) {
    const attrs = await storage.head(key);
    if (!attrs) return null;
    const originalType = attrs.httpMetadata?.contentType ?? "";
    if (IMAGE_CONTENT_TYPES.includes(originalType)) {
      const servedName = `${thumbSize}_${filename}`;
      const thumbKey = `${key.slice(0, key.length - filename.length)}thumbs_${filename}/${servedName}`;
      const cached = await getObject(storage, thumbKey, rangeHeader);
      if (cached === "invalid") { const h = await storage.head(thumbKey); throw new RangeNotSatisfiable(h?.size ?? 0, h?.httpMetadata?.contentType ?? "image/png", servedName); }
      if (cached) return served(cached.obj, servedName, "image/png", cached.range);
      const original = await storage.get(key);
      if (!original) return null;
      try {
        const bytes = new Uint8Array(await original.arrayBuffer());
        const thumb = await createThumb(bytes, originalType, thumbSize);
        await storage.put(thumbKey, thumb.bytes, { httpMetadata: { contentType: thumb.contentType } });
        const range = parseRange(rangeHeader, thumb.bytes.byteLength);
        if (range === "invalid") throw new RangeNotSatisfiable(thumb.bytes.byteLength, thumb.contentType, servedName);
        return { body: sliceRange(thumb.bytes, range ?? undefined), size: thumb.bytes.byteLength, contentType: thumb.contentType, uploaded: new Date(), name: servedName, range: range ?? undefined };
      } catch (err) {
        if (err instanceof RangeNotSatisfiable) throw err;
        console.warn(`voidbase: fallback to original - failed to create thumb ${servedName}`, err);
      }
    }
  }
  const got = await getObject(storage, key, rangeHeader);
  if (got === "invalid") throw new RangeNotSatisfiable(attrsOf(await storage.head(key)).size, attrsOf(await storage.head(key)).type, filename);
  if (!got) return null;
  return served(got.obj, filename, "application/octet-stream", got.range);
}

// Output format follows PocketBase: JPEG stays JPEG, everything else (png, webp, gif) is encoded as PNG.
export async function createThumb(bytes: Uint8Array, contentType: string, thumbSize: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  P = await photon();
  const m = THUMB_SIZE_RE.exec(thumbSize);
  if (!m) throw new Error("thumb size must be in WxH, WxHt, WxHb or WxHf format");
  const width = Number(m[1]), height = Number(m[2]), resizeType = m[3] ?? "";
  if (width === 0 && height === 0) throw new Error("thumb width and height cannot be zero at the same time");
  const img = P.PhotonImage.new_from_byteslice(bytes);
  try {
    let out: PhotonImage;
    if (width === 0 || height === 0) out = resizeTo(img, width, height);
    else if (resizeType === "f") out = fit(img, width, height);
    else out = fill(img, width, height, resizeType === "t" ? "top" : resizeType === "b" ? "bottom" : "center");
    try {
      if (contentType === "image/jpeg" || contentType === "image/jpg") return { bytes: out.get_bytes_jpeg(95), contentType: "image/jpeg" };
      return { bytes: out.get_bytes(), contentType: "image/png" };
    } finally { if (out !== img) out.free(); }
  } finally { img.free(); }
}

const roundHalfUp = (v: number) => Math.max(1, Math.floor(v + 0.5));

// imaging.Resize: a zero side is derived from the aspect ratio (round half up, at least 1)
function resizeTo(img: PhotonImage, w: number, h: number): PhotonImage {
  const sw = img.get_width(), sh = img.get_height();
  if (w === 0) w = roundHalfUp((h * sw) / sh);
  if (h === 0) h = roundHalfUp((w * sh) / sw);
  if (w === sw && h === sh) return img;
  return P.resize(img, w, h, P.SamplingFilter.Triangle);
}

// imaging.Fit: scale down to fit inside the box, never upscale (int truncation as in Go)
function fit(img: PhotonImage, maxW: number, maxH: number): PhotonImage {
  const sw = img.get_width(), sh = img.get_height();
  if (sw <= maxW && sh <= maxH) return img;
  const srcAspect = sw / sh, maxAspect = maxW / maxH;
  let nw: number, nh: number;
  if (srcAspect > maxAspect) { nw = maxW; nh = Math.trunc(nw / srcAspect); } else { nh = maxH; nw = Math.trunc(nh * srcAspect); }
  return P.resize(img, Math.max(1, nw), Math.max(1, nh), P.SamplingFilter.Triangle);
}

// imaging.Fill: sources of at least 100x100 are cropped to the target aspect first and then resized;
// smaller ones are resized to cover and then cropped. Both end at exactly w x h.
function fill(img: PhotonImage, w: number, h: number, anchor: "center" | "top" | "bottom"): PhotonImage {
  const sw = img.get_width(), sh = img.get_height();
  if (sw === w && sh === h) return img;
  const srcAspect = sw / sh, dstAspect = w / h;
  if (sw >= 100 && sh >= 100) {
    let cw = sw, ch = sh;
    if (srcAspect < dstAspect) ch = Math.trunc(Math.max(1, (sw * h) / w) + 0.5);
    else cw = Math.trunc(Math.max(1, (sh * w) / h) + 0.5);
    const cropped = cropAnchor(img, cw, ch, anchor);
    try { return P.resize(cropped, w, h, P.SamplingFilter.Triangle); } finally { if (cropped !== img) cropped.free(); }
  }
  const tmp = srcAspect < dstAspect ? resizeTo(img, w, 0) : resizeTo(img, 0, h);
  try { return cropAnchor(tmp, w, h, anchor); } finally { if (tmp !== img) tmp.free(); }
}

// imaging.CropAnchor with the Center / Top / Bottom anchors, clamped to the image
function cropAnchor(img: PhotonImage, w: number, h: number, anchor: "center" | "top" | "bottom"): PhotonImage {
  const sw = img.get_width(), sh = img.get_height();
  const x = Math.trunc((sw - w) / 2);
  const y = anchor === "top" ? 0 : anchor === "bottom" ? sh - h : Math.trunc((sh - h) / 2);
  const x1 = Math.max(0, x), y1 = Math.max(0, y), x2 = Math.min(sw, x + w), y2 = Math.min(sh, y + h);
  if (x1 === 0 && y1 === 0 && x2 === sw && y2 === sh) return img;
  return P.crop(img, x1, y1, x2, y2);
}
