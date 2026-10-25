import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

/** Generates the toolbar icons (shield on a dark tile) into public/icons. Run: node scripts/make-icons.mjs */

const TILE = [16, 46, 58];
const SHIELD = [211, 239, 223];
const CHECK = [22, 107, 91];

function shieldHalfWidth(v) {
  if (v < 0.2 || v > 0.86) return -1;
  if (v < 0.56) return 0.3;
  return 0.3 * (1 - (v - 0.56) / 0.3);
}

function onCheck(u, v) {
  const d1 = Math.abs((v - 0.5) - (u - 0.38)) / Math.SQRT2;
  const d2 = Math.abs((v - 0.62) + (u - 0.5)) / Math.SQRT2;
  return (u >= 0.36 && u <= 0.5 && d1 < 0.045 && v > 0.45) || (u >= 0.48 && u <= 0.68 && d2 < 0.045 && v < 0.64);
}

function pixel(u, v) {
  const r = 0.2;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if (Math.hypot(u - cx, v - cy) > r) return [0, 0, 0, 0];
  if (Math.abs(u - 0.5) <= shieldHalfWidth(v)) return [...(onCheck(u, v) ? CHECK : SHIELD), 255];
  return [...TILE, 255];
}

function png(size) {
  const samples = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const p = pixel((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          for (let c = 0; c < 3; c += 1) acc[c] += p[c] * p[3];
          acc[3] += p[3];
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = acc[3] / (samples * samples);
      for (let c = 0; c < 3; c += 1) raw[offset + c] = acc[3] ? Math.round(acc[c] / acc[3]) : 0;
      raw[offset + 3] = Math.round(alpha);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

await mkdir(new URL("../public/icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png(size));
}
