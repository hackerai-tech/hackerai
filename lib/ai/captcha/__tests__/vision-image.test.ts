/** @jest-environment node */
import sharp from "sharp";
import {
  FOCUS_MAX_LONG_SIDE,
  planFocusedChallenge,
  readPngSize,
  renderFocusedChallenge,
} from "../vision-image";

type Rect = { x: number; y: number; width: number; height: number };
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

/** A viewport screenshot: white page, gray frame, colored CSS-positioned markers. */
async function screenshot(
  viewport: { width: number; height: number },
  dpr: number,
  frame: Rect,
  markers: Array<Rect & { color: number[] }>,
) {
  const width = Math.round(viewport.width * dpr);
  const height = Math.round(viewport.height * dpr);
  const pixels = Buffer.alloc(width * height * 3, 255);
  const fill = (rect: Rect, color: number[]) => {
    for (
      let y = Math.round(rect.y * dpr);
      y < Math.round((rect.y + rect.height) * dpr);
      y++
    )
      for (
        let x = Math.round(rect.x * dpr);
        x < Math.round((rect.x + rect.width) * dpr);
        x++
      )
        pixels.set(color, (y * width + x) * 3);
  };
  fill(frame, [128, 128, 128]);
  for (const { color, ...rect } of markers) fill(rect, color);
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return {
    bytes: new Uint8Array(bytes),
    capture: {
      viewport,
      frame,
      image: { width, height },
      devicePixelRatio: dpr,
    },
  };
}

/** Maps a marker's focused-image centroid back through the returned transform. */
async function locate(
  focus: Awaited<ReturnType<typeof renderFocusedChallenge>>,
  color: number[],
) {
  const { data, info } = await sharp(focus.bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sumX = 0,
    sumY = 0,
    count = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (color.every((value, c) => Math.abs(data[i + c] - value) < 60)) {
        sumX += x + 0.5;
        sumY += y + 0.5;
        count++;
      }
    }
  expect(count).toBeGreaterThan(0);
  return {
    x: focus.cssOrigin.x + sumX / count / focus.pixelsPerCssPixel.x,
    y: focus.cssOrigin.y + sumY / count / focus.pixelsPerCssPixel.y,
  };
}

it("enlarges the whole public frame and maps its pixels back to CSS viewport coordinates", async () => {
  // Geometry of a complete Cloud capture whose puzzle was too small to read.
  const frame = { x: 156, y: 31, width: 520, height: 570 };
  const { bytes, capture } = await screenshot(
    { width: 1280, height: 633 },
    1,
    frame,
    [
      // Instruction text near the top-left and the Verify button bottom-right.
      { x: 160, y: 35, width: 10, height: 10, color: RED },
      { x: 660, y: 585, width: 12, height: 12, color: BLUE },
    ],
  );
  const focus = await renderFocusedChallenge(bytes, capture);
  expect(focus.image).toEqual({ width: 1040, height: 1140 });
  expect(readPngSize(focus.bytes)).toEqual(focus.image);
  expect(focus.cssOrigin).toEqual({ x: 156, y: 31 });
  const instruction = await locate(focus, RED);
  const button = await locate(focus, BLUE);
  expect(instruction.x).toBeCloseTo(165, 0);
  expect(instruction.y).toBeCloseTo(40, 0);
  expect(button.x).toBeCloseTo(666, 0);
  expect(button.y).toBeCloseTo(591, 0);
});

it.each([
  {
    name: "fractional frame at DPR 2",
    viewport: { width: 640, height: 400 },
    dpr: 2,
    frame: { x: 100.5, y: 20.25, width: 300, height: 350 },
    marker: { x: 250, y: 200, width: 6, height: 6 },
  },
  {
    name: "tall frame downscaled at DPR 3",
    viewport: { width: 700, height: 700 },
    dpr: 3,
    frame: { x: 240, y: 20, width: 200, height: 650 },
    marker: { x: 300, y: 600, width: 8, height: 8 },
  },
])("never reuses the native DPR alone: $name", async (fixture) => {
  const { bytes, capture } = await screenshot(
    fixture.viewport,
    fixture.dpr,
    fixture.frame,
    [{ ...fixture.marker, color: RED }],
  );
  const focus = await renderFocusedChallenge(bytes, capture);
  expect(Math.max(focus.image.width, focus.image.height)).toBeLessThanOrEqual(
    FOCUS_MAX_LONG_SIDE,
  );
  expect(focus.pixelsPerCssPixel.x).not.toBe(fixture.dpr);
  const marker = await locate(focus, RED);
  expect(marker.x).toBeCloseTo(fixture.marker.x + fixture.marker.width / 2, 0);
  expect(marker.y).toBeCloseTo(fixture.marker.y + fixture.marker.height / 2, 0);
});

it("returns independent x/y scales when output rounding differs", () => {
  const plan = planFocusedChallenge({
    viewport: { width: 1280, height: 1024 },
    frame: { x: 10, y: 12, width: 333, height: 1000 },
    image: { width: 1280, height: 1024 },
    devicePixelRatio: 1,
  });
  expect(plan.image).toEqual({ width: 533, height: 1600 });
  expect(plan.pixelsPerCssPixel.x).not.toBe(plan.pixelsPerCssPixel.y);
  // The far edges of the focused image land exactly on the frame's far edges.
  expect(
    plan.cssOrigin.x + plan.image.width / plan.pixelsPerCssPixel.x,
  ).toBeCloseTo(343, 9);
  expect(
    plan.cssOrigin.y + plan.image.height / plan.pixelsPerCssPixel.y,
  ).toBeCloseTo(1012, 9);
});

describe("rejects captures that cannot produce a faithful focused image", () => {
  const geometry = {
    viewport: { width: 400, height: 300 },
    frame: { x: 50, y: 20, width: 200, height: 250 },
    image: { width: 400, height: 300 },
    devicePixelRatio: 1,
  };

  it.each([
    ["clipped frame", { frame: { ...geometry.frame, height: 290 } }],
    ["negative origin", { frame: { ...geometry.frame, x: -1 } }],
    ["DPR mismatch", { devicePixelRatio: 2 }],
    ["unsupported DPR", { devicePixelRatio: 4 }],
  ])("%s", (_, change) => {
    expect(() => planFocusedChallenge({ ...geometry, ...change })).toThrow();
  });

  it("refuses bytes whose PNG dimensions differ from the capture", async () => {
    const { bytes } = await screenshot(
      { width: 401, height: 300 },
      1,
      geometry.frame,
      [],
    );
    await expect(renderFocusedChallenge(bytes, geometry)).rejects.toThrow(
      "does not match",
    );
  });

  it("refuses non-PNG and oversized images before decoding", () => {
    expect(() =>
      readPngSize(new TextEncoder().encode("not a png image")),
    ).toThrow();
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    header.set(new TextEncoder().encode("IHDR"), 12);
    const view = new DataView(header.buffer);
    view.setUint32(16, 20_000);
    view.setUint32(20, 20_000);
    expect(() => readPngSize(header)).toThrow("exceeds");
  });

  it("stops before decoding when the operation is canceled", async () => {
    const { bytes } = await screenshot(
      geometry.viewport,
      1,
      geometry.frame,
      [],
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderFocusedChallenge(bytes, geometry, controller.signal),
    ).rejects.toThrow();
  });
});
