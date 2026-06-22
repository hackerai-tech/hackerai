import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_PNG_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export type ImageValidationResult =
  | { valid: true; mediaType: string }
  | { valid: false; reason: string; detectedMediaType?: string };

const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
};

export const normalizeImageMediaType = (
  mediaType: string | undefined,
): string | undefined => {
  if (!mediaType) return undefined;
  const normalized = mediaType.toLowerCase();
  return MEDIA_TYPE_ALIASES[normalized] ?? normalized;
};

const startsWithBytes = (bytes: Uint8Array, signature: Uint8Array): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
};

const readUInt16BE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] << 8) | bytes[offset + 1];

const readUInt32BE = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] * 0x100 + bytes[offset + 1]) * 0x100 + bytes[offset + 2]) *
    0x100 +
    bytes[offset + 3]) >>>
  0;

const readUInt32LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>>
  0;

const readAscii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

let crcTable: Uint32Array | undefined;

const getCrcTable = (): Uint32Array => {
  if (crcTable) return crcTable;

  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[i] = crc >>> 0;
  }
  return crcTable;
};

const crc32 = (bytes: Uint8Array): number => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const detectImageMediaType = (bytes: Uint8Array): string | undefined => {
  if (startsWithBytes(bytes, PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    (readAscii(bytes, 0, 6) === "GIF87a" || readAscii(bytes, 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
};

const validPngBitDepth = (colorType: number, bitDepth: number): boolean => {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case 2:
    case 4:
    case 6:
      return [8, 16].includes(bitDepth);
    case 3:
      return [1, 2, 4, 8].includes(bitDepth);
    default:
      return false;
  }
};

const validatePng = (bytes: Uint8Array): string | null => {
  if (!startsWithBytes(bytes, PNG_SIGNATURE)) return "missing_png_signature";

  let offset = PNG_SIGNATURE.length;
  let seenIhdr = false;
  let seenIdat = false;
  let seenIend = false;
  const idatChunks: Buffer[] = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return "truncated_png_chunk";

    const length = readUInt32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;

    if (dataEnd + 4 > bytes.length) return "truncated_png_chunk_data";

    const expectedCrc = readUInt32BE(bytes, crcOffset);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) return `invalid_png_${type}_crc`;

    if (type === "IHDR") {
      if (seenIhdr || offset !== PNG_SIGNATURE.length)
        return "invalid_png_ihdr";
      if (length !== 13) return "invalid_png_ihdr_length";
      const width = readUInt32BE(bytes, dataStart);
      const height = readUInt32BE(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (width === 0 || height === 0) return "invalid_png_dimensions";
      if (!validPngBitDepth(colorType, bitDepth)) {
        return "invalid_png_color_type";
      }
      if (compression !== 0 || filter !== 0 || interlace > 1) {
        return "invalid_png_header";
      }
      seenIhdr = true;
    } else if (type === "IDAT") {
      if (!seenIhdr || seenIend) return "invalid_png_idat_order";
      seenIdat = true;
      if (length > 0) {
        idatChunks.push(Buffer.from(bytes.subarray(dataStart, dataEnd)));
      }
    } else if (type === "IEND") {
      if (length !== 0) return "invalid_png_iend_length";
      seenIend = true;
      offset = crcOffset + 4;
      break;
    }

    offset = crcOffset + 4;
  }

  if (!seenIhdr) return "missing_png_ihdr";
  if (!seenIdat || idatChunks.length === 0) return "missing_png_idat";
  if (!seenIend) return "missing_png_iend";
  if (bytes.subarray(offset).some((byte) => byte !== 0)) {
    return "unexpected_png_trailing_data";
  }

  try {
    inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: MAX_PNG_DECOMPRESSED_BYTES,
    });
  } catch {
    return "invalid_png_image_data";
  }

  return null;
};

const isJpegSofMarker = (marker: number): boolean =>
  [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ].includes(marker);

const validateJpeg = (bytes: Uint8Array): string | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return "missing_jpeg_signature";
  }
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    return "missing_jpeg_eoi";
  }

  let offset = 2;
  let sawFrame = false;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];

    if (marker === 0xd9) break;
    if (marker === 0xda) return sawFrame ? null : "missing_jpeg_frame";
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return "truncated_jpeg_segment";

    const segmentLength = readUInt16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return "invalid_jpeg_segment_length";
    }

    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7) return "invalid_jpeg_frame";
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      if (width === 0 || height === 0) return "invalid_jpeg_dimensions";
      sawFrame = true;
    }

    offset += segmentLength;
  }

  return sawFrame ? null : "missing_jpeg_frame";
};

const validateGif = (bytes: Uint8Array): string | null => {
  if (
    bytes.length < 14 ||
    (readAscii(bytes, 0, 6) !== "GIF87a" && readAscii(bytes, 0, 6) !== "GIF89a")
  ) {
    return "missing_gif_signature";
  }
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (width === 0 || height === 0) return "invalid_gif_dimensions";
  if (bytes[bytes.length - 1] !== 0x3b) return "missing_gif_trailer";
  return null;
};

const validateWebp = (bytes: Uint8Array): string | null => {
  if (
    bytes.length < 20 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP"
  ) {
    return "missing_webp_signature";
  }

  const riffSize = readUInt32LE(bytes, 4);
  if (riffSize + 8 > bytes.length) return "truncated_webp";

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = readAscii(bytes, offset, 4);
    const chunkSize = readUInt32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) return "truncated_webp_chunk";

    if (chunkType === "VP8 ") {
      if (chunkSize < 10) return "invalid_webp_vp8_chunk";
      if (
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        return "invalid_webp_vp8_start_code";
      }
      return null;
    }

    if (chunkType === "VP8L") {
      return chunkSize >= 5 && bytes[dataStart] === 0x2f
        ? null
        : "invalid_webp_vp8l_chunk";
    }

    if (chunkType === "VP8X") {
      if (chunkSize < 10) return "invalid_webp_vp8x_chunk";
      const width =
        1 +
        bytes[dataStart + 4] +
        (bytes[dataStart + 5] << 8) +
        (bytes[dataStart + 6] << 16);
      const height =
        1 +
        bytes[dataStart + 7] +
        (bytes[dataStart + 8] << 8) +
        (bytes[dataStart + 9] << 16);
      if (width === 0 || height === 0) return "invalid_webp_dimensions";
    }

    offset = dataEnd + (chunkSize % 2);
  }

  return "missing_webp_image_chunk";
};

export function validateImageBytes(
  input: Uint8Array,
  expectedMediaType?: string,
): ImageValidationResult {
  if (input.byteLength === 0) return { valid: false, reason: "empty_image" };

  const detectedMediaType = detectImageMediaType(input);
  if (!detectedMediaType) {
    return { valid: false, reason: "unrecognized_image_bytes" };
  }

  const expected = normalizeImageMediaType(expectedMediaType);
  if (expected && expected !== detectedMediaType) {
    return {
      valid: false,
      reason: "declared_media_type_mismatch",
      detectedMediaType,
    };
  }

  const reason =
    detectedMediaType === "image/png"
      ? validatePng(input)
      : detectedMediaType === "image/jpeg"
        ? validateJpeg(input)
        : detectedMediaType === "image/gif"
          ? validateGif(input)
          : detectedMediaType === "image/webp"
            ? validateWebp(input)
            : "unsupported_image_type";

  return reason
    ? { valid: false, reason, detectedMediaType }
    : { valid: true, mediaType: detectedMediaType };
}
