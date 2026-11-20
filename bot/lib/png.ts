import { inflateSync, deflateSync } from "node:zlib";

export type DecodedPng = {
  width: number;
  height: number;
  /** RGB bytes, row-major, no filter bytes. */
  rgb: Buffer;
};

function readChunk(buf: Buffer, offset: number): { type: string; data: Buffer; next: number } {
  const len = buf.readUInt32BE(offset);
  const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
  const data = buf.subarray(offset + 8, offset + 8 + len);
  return { type, data, next: offset + 12 + len };
}

/** Decode a common 8-bit RGB/RGBA non-interlaced PNG into raw RGB. */
export function decodePngToRgb(png: Buffer): DecodedPng {
  if (png.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") {
    throw new Error("Not a PNG file");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idats: Buffer[] = [];

  while (offset + 12 <= png.length) {
    const chunk = readChunk(png, offset);
    offset = chunk.next;
    if (chunk.type === "IHDR") {
      width = chunk.data.readUInt32BE(0);
      height = chunk.data.readUInt32BE(4);
      bitDepth = chunk.data[8]!;
      colorType = chunk.data[9]!;
      const interlace = chunk.data[12]!;
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
      if (interlace !== 0) throw new Error("Interlaced PNG not supported");
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`Unsupported PNG color type ${colorType}`);
      }
    } else if (chunk.type === "IDAT") {
      idats.push(chunk.data);
    } else if (chunk.type === "IEND") {
      break;
    }
  }

  if (!width || !height) throw new Error("PNG missing IHDR");
  const compressed = Buffer.concat(idats);
  const raw = inflateSync(compressed);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error("PNG IDAT truncated");

  const rgb = Buffer.alloc(width * height * 3);
  let src = 0;
  let dst = 0;
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!;
    const row = raw.subarray(src, src + stride);
    src += stride;
    const out = Buffer.alloc(stride);

    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };

    for (let i = 0; i < stride; i++) {
      const x = row[i]!;
      const a = i >= bpp ? out[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 0xff;
      else if (filter === 2) val = (x + b) & 0xff;
      else if (filter === 3) val = (x + Math.floor((a + b) / 2)) & 0xff;
      else if (filter === 4) val = (x + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      out[i] = val;
    }

    for (let x = 0; x < width; x++) {
      const i = x * bpp;
      rgb[dst++] = out[i]!;
      rgb[dst++] = out[i + 1]!;
      rgb[dst++] = out[i + 2]!;
    }
    prev = out;
  }

  return { width, height, rgb };
}

export function flateRgb(rgb: Buffer): Buffer {
  return deflateSync(rgb);
}
