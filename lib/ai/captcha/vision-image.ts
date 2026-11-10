import type { VisionCaptureResult } from "./vision-capture";

// Vision models resample larger images; beyond this the model gains no detail.
export const FOCUS_MAX_LONG_SIDE = 1600;
// Enlargement beyond this only interpolates the same captured pixels.
const FOCUS_MAX_UPSCALE = 2;
// The sandbox capture program allows a 1920x1600 CSS viewport at DPR <= 3.
export const MAX_CAPTURE_BYTES = 10_000_000;
export const MAX_CAPTURE_PIXELS = 1920 * 3 * (1600 * 3);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** An enlarged copy of the whole public challenge frame, written after the original. */
export type FocusedChallenge = {
  path: string;
  image: { width: number; height: number };
  /** CSS viewport position of focused-image pixel (0, 0). */
  cssOrigin: { x: number; y: number };
  cssSize: { width: number; height: number };
  /** viewportX = cssOrigin.x + focusX / pixelsPerCssPixel.x (and likewise for y). */
  pixelsPerCssPixel: { x: number; y: number };
};

type CaptureGeometry = Pick<
  VisionCaptureResult,
  "viewport" | "frame" | "image" | "devicePixelRatio"
>;

/** Reads IHDR dimensions after enforcing byte and pixel bounds. */
export function readPngSize(bytes: Uint8Array) {
  if (
    bytes.length < 24 ||
    bytes.length > MAX_CAPTURE_BYTES ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    throw new Error("Invalid challenge image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width * height > MAX_CAPTURE_PIXELS)
    throw new Error("Challenge image exceeds capture bounds.");
  return { width, height };
}

/**
 * Plans a uniform-scale crop of the complete frame. Rounding the output size
 * can make the x and y scales differ slightly, so both are returned exactly.
 */
export function planFocusedChallenge(capture: CaptureGeometry) {
  const { viewport, frame, image, devicePixelRatio: dpr } = capture;
  if (
    !(dpr > 0 && dpr <= 3) ||
    Math.abs(image.width - viewport.width * dpr) > 1 ||
    Math.abs(image.height - viewport.height * dpr) > 1 ||
    image.width * image.height > MAX_CAPTURE_PIXELS
  )
    throw new Error("Challenge image scale is inconsistent.");
  if (
    frame.x < 0 ||
    frame.y < 0 ||
    frame.x + frame.width > viewport.width ||
    frame.y + frame.height > viewport.height
  )
    throw new Error("Challenge frame is not fully inside the viewport.");
  const left = Math.floor(frame.x * dpr);
  const top = Math.floor(frame.y * dpr);
  const width =
    Math.min(image.width, Math.ceil((frame.x + frame.width) * dpr)) - left;
  const height =
    Math.min(image.height, Math.ceil((frame.y + frame.height) * dpr)) - top;
  if (width < 1 || height < 1)
    throw new Error("Challenge frame is not fully inside the viewport.");
  const scale = Math.min(
    FOCUS_MAX_LONG_SIDE / Math.max(width, height),
    FOCUS_MAX_UPSCALE,
  );
  const output = {
    width: Math.min(
      FOCUS_MAX_LONG_SIDE,
      Math.max(1, Math.round(width * scale)),
    ),
    height: Math.min(
      FOCUS_MAX_LONG_SIDE,
      Math.max(1, Math.round(height * scale)),
    ),
  };
  return {
    extract: { left, top, width, height },
    image: output,
    cssOrigin: { x: left / dpr, y: top / dpr },
    cssSize: { width: width / dpr, height: height / dpr },
    // Image pixels already include the DPR; never apply DPR again to this image.
    pixelsPerCssPixel: {
      x: (output.width / width) * dpr,
      y: (output.height / height) * dpr,
    },
  };
}

/** Renders the planned crop from the exact qualified viewport bytes. */
export async function renderFocusedChallenge(
  bytes: Uint8Array,
  capture: CaptureGeometry,
  signal?: AbortSignal,
) {
  const size = readPngSize(bytes);
  if (
    size.width !== capture.image.width ||
    size.height !== capture.image.height
  )
    throw new Error("Challenge image does not match its capture.");
  const { extract, ...focus } = planFocusedChallenge(capture);
  signal?.throwIfAborted();
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(bytes, {
    limitInputPixels: MAX_CAPTURE_PIXELS,
  })
    .timeout({ seconds: 5 })
    .extract(extract)
    // The planned size keeps the aspect ratio up to one rounded pixel.
    .resize(focus.image.width, focus.image.height, { fit: "fill" })
    .png()
    .toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  if (
    info.format !== "png" ||
    info.width !== focus.image.width ||
    info.height !== focus.image.height ||
    data.length > MAX_CAPTURE_BYTES
  )
    throw new Error("Focused challenge image is invalid.");
  return { bytes: data, ...focus };
}
