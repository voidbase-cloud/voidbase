// IEEE CRC32 as an unsigned decimal string (PocketBase uses crc32.ChecksumIEEE for field ids).
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[i] = c >>> 0;
}
export function crc32(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return String((crc ^ 0xffffffff) >>> 0);
}
