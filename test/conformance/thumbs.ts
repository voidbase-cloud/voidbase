// Thumbnail conformance: the same images uploaded to PocketBase and voidbase, every declared size (plus an
// undeclared one and a garbage one) fetched from both; status, content type, served name and decoded
// dimensions must agree. Pixel data differs (Go imaging vs Photon), so it is not compared.
//   bun test/conformance/thumbs.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
import { PhotonImage } from "@cf-wasm/photon/node";

const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const SIZES = ["100x100", "100x100t", "100x100b", "100x100f", "0x50", "50x0", "300x200f", "40x30"];
const PROBES = [...SIZES, "999x999", "abc"];

function gradient(w: number, h: number): PhotonImage {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; px[i] = (x * 255) / w; px[i + 1] = (y * 255) / h; px[i + 2] = 128; px[i + 3] = 255; }
  return new PhotonImage(px, w, h);
}
const files: { name: string; type: string; bytes: Uint8Array; image: boolean }[] = [
  { name: "wide.png", type: "image/png", bytes: gradient(200, 120).get_bytes(), image: true },
  { name: "tall.jpg", type: "image/jpeg", bytes: gradient(120, 200).get_bytes_jpeg(90), image: true },
  { name: "small.png", type: "image/png", bytes: gradient(60, 40).get_bytes(), image: true },
  { name: "wide.webp", type: "image/webp", bytes: gradient(200, 120).get_bytes_webp(), image: true },
  { name: "note.txt", type: "text/plain", bytes: new TextEncoder().encode("not an image\n"), image: false },
];

async function setup(base: string) {
  const auth = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CREDS) }).then((r) => r.json()) as { token: string };
  const h = { authorization: auth.token };
  await fetch(`${base}/api/collections/ks_thumb`, { method: "DELETE", headers: h });
  const created = await fetch(`${base}/api/collections`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ name: "ks_thumb", type: "base", fields: [{ name: "img", type: "file", maxSelect: 9, maxSize: 0, mimeTypes: [], protected: false, thumbs: SIZES }] }) });
  if (created.status !== 200) throw new Error(`${base} create collection ${created.status} ${await created.text()}`);
  const fd = new FormData();
  for (const f of files) fd.append("img", new File([f.bytes as BlobPart], f.name, { type: f.type }));
  const rec = await fetch(`${base}/api/collections/ks_thumb/records`, { method: "POST", headers: h, body: fd });
  if (rec.status !== 200) throw new Error(`${base} create record ${rec.status} ${await rec.text()}`);
  const json = await rec.json() as { id: string; img: string[] };
  return { h, id: json.id, names: json.img };
}
async function teardown(base: string, h: Record<string, string>) { await fetch(`${base}/api/collections/ks_thumb`, { method: "DELETE", headers: h }); }

interface Seen { status: number; type: string; disposition: string; dims: string; text?: string }
async function probe(base: string, id: string, name: string, size: string, image: boolean): Promise<Seen> {
  const r = await fetch(`${base}/api/files/ks_thumb/${id}/${name}?thumb=${encodeURIComponent(size)}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let dims = "-";
  if (image && r.status === 200) { try { const im = PhotonImage.new_from_byteslice(bytes); dims = `${im.get_width()}x${im.get_height()}`; im.free(); } catch { dims = "undecodable"; } }
  return { status: r.status, type: r.headers.get("content-type") ?? "", disposition: (r.headers.get("content-disposition") ?? "").replace(/_[a-z0-9]{10}\./, "_X.").replace(/"/g, ""), dims, text: image ? undefined : new TextDecoder().decode(bytes) };
}

const pb = await setup(PB);
const vb = await setup(VB);
let pass = 0, fail = 0;
try {
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    for (const size of PROBES) {
      const [a, b] = await Promise.all([probe(PB, pb.id, pb.names[i]!, size, f.image), probe(VB, vb.id, vb.names[i]!, size, f.image)]);
      const same = a.status === b.status && a.type === b.type && a.dims === b.dims && a.disposition === b.disposition && a.text === b.text;
      if (same) pass++; else fail++;
      console.log(`${same ? "PASS" : "FAIL"}  ${f.name.padEnd(10)} ${size.padEnd(9)} pb=${a.status} ${a.type} ${a.dims} ${a.disposition}${same ? "" : `\n      vb=${b.status} ${b.type} ${b.dims} ${b.disposition}`}`);
    }
  }
  // http.ServeContent semantics: range requests, 304 on If-Modified-Since, ?download forces attachment
  const extra: [string, Record<string, string>, string][] = [
    ["range 0-9", { Range: "bytes=0-9" }, ""], ["range suffix", { Range: "bytes=-5" }, ""], ["range open", { Range: "bytes=10-" }, ""], ["range bad", { Range: "bytes=99999-" }, ""],
    ["if-modified-since future", { "If-Modified-Since": new Date(Date.now() + 86400000).toUTCString() }, ""], ["download=1", {}, "&download=1"], ["download=false", {}, "&download=false"],
  ];
  for (const [label, hdrs, qs] of extra) {
    const get = async (base: string, id: string, name: string) => { const r = await fetch(`${base}/api/files/ks_thumb/${id}/${name}?thumb=40x30${qs}`, { headers: hdrs }); const len = (await r.arrayBuffer()).byteLength; const cr = r.headers.get("content-range") ?? "-";
      // encoders differ (Go imaging vs Photon), so sizes are compared structurally: does the range math match the body?
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr); let shape: string;
      if (m) { const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])]; const tail = end === total - 1; shape = `${tail && start > 10 ? `tail ${total - start}` : `start ${start}`}${tail ? "-end" : `-${end}`} bodyMatches=${len === end - start + 1}`; }
      else shape = cr.startsWith("bytes */") ? "unsatisfiable" : `full bodyMatches=${len > 0}`;
      return `${r.status} ${shape} cd=${(r.headers.get("content-disposition") ?? "-").split(";")[0]}`; };
    const [a, b] = await Promise.all([get(PB, pb.id, pb.names[0]!), get(VB, vb.id, vb.names[0]!)]);
    const same = a === b; same ? pass++ : fail++;
    console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(24)} pb=${a}${same ? "" : `\n      vb=${b}`}`);
  }
  // cached thumb: the second request must return the same bytes
  const url = `${VB}/api/files/ks_thumb/${vb.id}/${vb.names[0]}?thumb=100x100`;
  const first = await fetch(url).then((r) => r.arrayBuffer()), second = await fetch(url).then((r) => r.arrayBuffer());
  const cachedOk = first.byteLength === second.byteLength && Buffer.from(first).equals(Buffer.from(second));
  cachedOk ? pass++ : fail++;
  console.log(`${cachedOk ? "PASS" : "FAIL"}  cached thumb served identically (${first.byteLength} bytes)`);
} finally {
  await teardown(PB, pb.h);
  await teardown(VB, vb.h);
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
