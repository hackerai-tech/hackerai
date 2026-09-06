import type { ModelMessage } from "ai";
import {
  AbliterationVisionError,
  createAbliterationVisionPreprocessor,
} from "../abliteration-vision";
import { exceedsAbliterationImageLimit } from "@/lib/ai/abliteration-media";

jest.mock("server-only", () => ({}));
jest.mock("../auxiliary-vision", () => ({
  describeImageWithAuxiliaryVision: jest.fn(),
}));

const images = (count: number): ModelMessage[] => [
  {
    role: "user",
    content: Array.from({ length: count }, (_, i) => ({
      type: "image",
      image: `https://example.test/${i}.png`,
      mediaType: "image/png",
    })),
  },
];
const result = {
  description: "OCR <text> & details",
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  model: "vision",
};
const setup = () => {
  const describe = jest.fn(async () => result);
  const onCost = jest.fn();
  const controller = new AbortController();
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "user",
    chatId: "chat",
    abortSignal: controller.signal,
    onCost,
    describe,
  });
  return { describe, onCost, controller, preprocess };
};

it("leaves up to four images native without OCR", async () => {
  const { describe, preprocess } = setup();
  const input = images(4);
  expect(await preprocess(input)).toBe(input);
  expect(describe).not.toHaveBeenCalled();
});

it("describes every image in a 14-image history with indexed, escaped text", async () => {
  const { describe, preprocess } = setup();
  const input = images(14);
  const original = JSON.stringify(input);
  const output = await preprocess(input);
  expect(describe).toHaveBeenCalledTimes(14);
  expect(exceedsAbliterationImageLimit(output)).toBe(false);
  expect(JSON.stringify(output)).toContain('index=\\"14\\"');
  expect(JSON.stringify(output)).toContain("OCR &lt;text&gt; &amp; details");
  expect(JSON.stringify(input)).toBe(original);
  await preprocess(input);
  expect(describe).toHaveBeenCalledTimes(14);
});

it("counts attachments and tool images together and preserves tool identity/text", async () => {
  const { describe, preprocess } = setup();
  const input = images(4);
  input.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "view",
        toolName: "file",
        output: {
          type: "content",
          value: [
            { type: "text", text: "File evidence" },
            { type: "image-data", data: "test", mediaType: "image/png" },
          ],
        },
      },
    ],
  });
  const output = await preprocess(input);
  expect(describe).toHaveBeenCalledTimes(5);
  expect(describe).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "file_view", image: "test" }),
  );
  expect(output[1]).toMatchObject({
    role: "tool",
    content: [
      {
        toolCallId: "view",
        toolName: "file",
        output: {
          value: [{ type: "text", text: "File evidence" }, { type: "text" }],
        },
      },
    ],
  });
});

it("never starts a fifth OCR call until its batch finishes", async () => {
  const pending: Array<() => void> = [];
  const describe = jest.fn(
    () =>
      new Promise<typeof result>((resolve) =>
        pending.push(() => resolve(result)),
      ),
  );
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "u",
    chatId: "c",
    abortSignal: new AbortController().signal,
    onCost: jest.fn(),
    describe,
  });
  const work = preprocess(images(9));
  expect(describe).toHaveBeenCalledTimes(4);
  for (const done of pending.splice(0)) done();
  // Yield to the batch's Promise.allSettled continuation.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(describe).toHaveBeenCalledTimes(8);
  for (const done of pending.splice(0)) done();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(describe).toHaveBeenCalledTimes(9);
  for (const done of pending.splice(0)) done();
  await work;
});

it("deduplicates repeated images without losing their indexed occurrences", async () => {
  const { describe, preprocess } = setup();
  const repeated = images(3);
  const input = [...repeated, ...repeated];
  const output = await preprocess(input);
  expect(describe).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(output)).toContain('index=\\"6\\"');
});

it("fails closed, preserves completed-call cost, and does not restart a failed batch", async () => {
  const controller = new AbortController();
  const onCost = jest.fn();
  const describe = jest.fn(
    async (args: { image: string; onCost?: (cost: number) => void }) => {
      if (args.image.endsWith("0.png"))
        throw new Error("provider secret error");
      args.onCost?.(0.01);
      return result;
    },
  );
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "u",
    chatId: "c",
    abortSignal: controller.signal,
    onCost,
    describe,
  });
  await expect(preprocess(images(9))).rejects.toThrow(AbliterationVisionError);
  expect(describe).toHaveBeenCalledTimes(4);
  expect(onCost).toHaveBeenCalledTimes(3);
  await expect(preprocess(images(9))).rejects.not.toThrow(
    "provider secret error",
  );
  expect(describe).toHaveBeenCalledTimes(4);
});

it("does not launch OCR after cancellation", async () => {
  const { describe, controller, preprocess } = setup();
  controller.abort();
  await expect(preprocess(images(5))).rejects.toHaveProperty(
    "name",
    "AbortError",
  );
  expect(describe).not.toHaveBeenCalled();
});

it("supports SDK binary image attachments", async () => {
  const { describe, preprocess } = setup();
  const input = images(4);
  input.push({
    role: "user",
    content: [
      {
        type: "file",
        data: new Uint8Array([1, 2, 3]),
        mediaType: "image/jpeg",
        filename: 'screenshot"<one>.jpg',
      },
    ],
  });
  const output = await preprocess(input);
  expect(describe).toHaveBeenLastCalledWith(
    expect.objectContaining({ image: "AQID", mediaType: "image/jpeg" }),
  );
  expect(JSON.stringify(output)).toContain("screenshot&quot;&lt;one&gt;.jpg");
});
