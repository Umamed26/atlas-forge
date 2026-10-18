/**
 * Node-only fast PNG encoder for large exports.
 *
 * Skia's PNG writer spends several seconds on a detailed 4096² parchment plate;
 * zlib level-1 with PNG "no filter" scanlines is ~4x faster at the cost of a
 * larger file (still a standards-compliant PNG). The browser never imports this
 * module; it is exposed as `@atlas/render/png`.
 */
import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export type PngFilter = "none" | "sub" | "up";

export interface PngEncodeOptions {
  /** zlib level; 1 is fastest, 3 balances size/time on large plates. */
  level?: number;
  /** PNG row filter. "up" compresses parchment gradients best. */
  filter?: PngFilter;
}

/** Encode raw RGBA pixels (top-down rows) to a PNG buffer. */
export function encodePngRgba(
  rgba: Buffer | Uint8Array,
  width: number,
  height: number,
  options: PngEncodeOptions = {},
): Buffer {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  const source = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const filter = options.filter ?? "up";
  const filterByte = filter === "up" ? 2 : filter === "sub" ? 1 : 0;
  if (filter === "none") {
    for (let y = 0; y < height; y += 1) {
      const o = y * (stride + 1);
      raw[o] = 0;
      source.copy(raw, o + 1, y * stride, (y + 1) * stride);
    }
  } else {
    // First row is filtered as "none" (no previous row for Up).
    raw[0] = 0;
    source.copy(raw, 1, 0, stride);
    for (let y = 1; y < height; y += 1) {
      const o = y * (stride + 1);
      const row = y * stride;
      const prev = row - stride;
      raw[o] = filterByte;
      for (let i = 0; i < stride; i += 1) {
        const cur = source[row + i];
        const reference = filter === "up" ? source[prev + i] : i >= 4 ? source[row + i - 4] : 0;
        raw[o + 1 + i] = (cur - reference) & 0xff;
      }
    }
  }
  const compressed = deflateSync(raw, { level: options.level ?? 1 });
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Minimal canvas shape needed by the fast encoder (browser canvas excluded). */
export interface CanvasWithData {
  width: number;
  height: number;
  data(): Uint8Array;
}

/** Encode a @napi-rs/canvas canvas to PNG using the fast path. */
export function encodeCanvasPng(canvas: CanvasWithData, options: PngEncodeOptions = {}): Buffer {
  return encodePngRgba(canvas.data(), canvas.width, canvas.height, options);
}
