import { convertToModelMessages, type UIMessage } from "ai";
import {
  AUXILIARY_VISION_RECOVERY_TIMEOUT_MS,
  AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS,
  AuxiliaryVisionTimeoutError,
  describeImageWithAuxiliaryVision,
  type AuxiliaryVisionDescriptionCacheWriter,
  type AuxiliaryVisionModelRunner,
} from "../auxiliary-vision";
import { AUXILIARY_VISION_SLUG } from "@/lib/ai/providers";
import { createAbliterationVisionPreprocessor } from "../abliteration-vision";
import { wrapProviderTerminalError } from "@/lib/api/provider-terminal-error";
import { getUserFriendlyProviderError } from "@/lib/utils/error-utils";

jest.mock("server-only", () => ({}));

const waitForAbort: AuxiliaryVisionModelRunner = ({ abortSignal }) =>
  new Promise((_, reject) => {
    abortSignal.addEventListener("abort", () => reject(abortSignal.reason), {
      once: true,
    });
  });
const descriptorArgs = {
  image: "private-image",
  mediaType: "image/png",
  source: "attachment" as const,
};
const imageHistory = (count = 5): UIMessage[] => [
  {
    id: "message",
    role: "user",
    parts: Array.from({ length: count }, (_, i) => ({
      type: "file" as const,
      url: `https://files.test/${i}.png`,
      mediaType: "image/png",
      fileId: `file-${i}`,
    })),
  },
];

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("retries one timed-out image with a fresh 35s deadline", async () => {
  jest.useFakeTimers();
  const runner = jest
    .fn<
      ReturnType<AuxiliaryVisionModelRunner>,
      Parameters<AuxiliaryVisionModelRunner>
    >()
    .mockImplementationOnce(waitForAbort)
    .mockImplementationOnce(
      ({ abortSignal }) =>
        new Promise((resolve) =>
          setTimeout(() => {
            expect(abortSignal.aborted).toBe(false);
            resolve({
              text: "Recovered image",
              usage: { raw: { cost: 0.002 } },
            });
          }, 25_000),
        ),
    );
  const onCost = jest.fn();
  const pending = describeImageWithAuxiliaryVision({
    ...descriptorArgs,
    modelRunner: runner,
    onCost,
  });
  await jest.advanceTimersByTimeAsync(20_000);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls[0][0].abortSignal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(25_000);
  await expect(pending).resolves.toMatchObject({
    description: "Recovered image",
  });
  expect(onCost.mock.calls).toEqual([[0.002]]);
  expect(jest.getTimerCount()).toBe(0);
});

it("reports timeout exhaustion with its original cause and a safe image-specific message", async () => {
  jest.useFakeTimers();
  // Some SDKs replace the timeout reason with a generic AbortError.
  const runner = jest.fn<
    ReturnType<AuxiliaryVisionModelRunner>,
    Parameters<AuxiliaryVisionModelRunner>
  >(
    ({ abortSignal }) =>
      new Promise((_, reject) => {
        abortSignal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const pending = describeImageWithAuxiliaryVision({
    ...descriptorArgs,
    modelRunner: runner,
  }).catch((e) => e);
  await jest.advanceTimersByTimeAsync(55_000);
  const error = await pending;
  expect(error).toBeInstanceOf(AuxiliaryVisionTimeoutError);
  expect(error.cause).toBeDefined();
  const terminal = wrapProviderTerminalError(error, {});
  expect(terminal.message).toBe(
    "Provider terminal error category=timeout origin=auxiliary_vision",
  );
  expect(getUserFriendlyProviderError(terminal)).toBe(
    "Image analysis took too long. Please retry or send fewer images.",
  );
  expect(runner).toHaveBeenCalledTimes(2);
  expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain(
    "private-image",
  );
  expect(jest.getTimerCount()).toBe(0);
});

it("completes a 20-image batch by retrying only the timed-out image", async () => {
  jest.useFakeTimers();
  const messages = imageHistory(20);
  let timedOut = false;
  const runner = jest.fn<
    ReturnType<AuxiliaryVisionModelRunner>,
    Parameters<AuxiliaryVisionModelRunner>
  >(async (args) => {
    if (args.image.includes("/9.png") && !timedOut) {
      timedOut = true;
      return waitForAbort(args);
    }
    return { text: "Image evidence", usage: { raw: { cost: 0.001 } } };
  });
  const onCost = jest.fn();
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "owner",
    chatId: "chat",
    abortSignal: new AbortController().signal,
    onCost,
    describe: (args) =>
      describeImageWithAuxiliaryVision({ ...args, modelRunner: runner }),
  });
  const pending = preprocess(await convertToModelMessages(messages));
  await jest.advanceTimersByTimeAsync(20_000);
  const output = await pending;
  expect(runner).toHaveBeenCalledTimes(21);
  expect(
    runner.mock.calls.filter(([args]) => args.image.includes("/9.png")),
  ).toHaveLength(2);
  expect(onCost).toHaveBeenCalledTimes(20);
  expect(output[0].content).toHaveLength(20);
  expect(JSON.stringify(output)).not.toContain('"type":"image"');
  expect(jest.getTimerCount()).toBe(0);
});

it("settles a late billed attempt before retrying and accounts for both results", async () => {
  jest.useFakeTimers();
  const onCost = jest.fn();
  const runner = jest
    .fn<
      ReturnType<AuxiliaryVisionModelRunner>,
      Parameters<AuxiliaryVisionModelRunner>
    >()
    .mockImplementationOnce(
      ({ abortSignal }) =>
        new Promise((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => resolve({ text: "Late", usage: { raw: { cost: 0.001 } } }),
            { once: true },
          );
        }),
    )
    .mockResolvedValueOnce({
      text: "Recovered",
      usage: { raw: { cost: 0.002 } },
    });
  const pending = describeImageWithAuxiliaryVision({
    ...descriptorArgs,
    modelRunner: runner,
    onCost,
  });
  await jest.advanceTimersByTimeAsync(20_000);
  await expect(pending).resolves.toMatchObject({ description: "Recovered" });
  expect(onCost.mock.calls).toEqual([[0.001], [0.002]]);
  expect(runner).toHaveBeenCalledTimes(2);
});

it.each([400, 403, 413])(
  "does not retry a permanent HTTP %s failure",
  async (statusCode) => {
    const failure = Object.assign(new Error("Invalid input"), { statusCode });
    const runner = jest.fn(async () => {
      throw failure;
    });
    await expect(
      describeImageWithAuxiliaryVision({
        ...descriptorArgs,
        modelRunner: runner,
      }),
    ).rejects.toBe(failure);
    expect(runner).toHaveBeenCalledTimes(1);
  },
);

it.each([429, 503])(
  "keeps transient HTTP %s failures within two attempts",
  async (statusCode) => {
    const failure = Object.assign(new Error("Temporarily unavailable"), {
      statusCode,
    });
    const runner = jest.fn(async () => {
      throw failure;
    });
    await expect(
      describeImageWithAuxiliaryVision({
        ...descriptorArgs,
        modelRunner: runner,
      }),
    ).rejects.toBe(failure);
    expect(runner).toHaveBeenCalledTimes(2);
  },
);

it("honors cancellation during the retry and never dispatches a third call", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const runner = jest.fn(waitForAbort);
  const pending = describeImageWithAuxiliaryVision({
    ...descriptorArgs,
    modelRunner: runner,
    abortSignal: controller.signal,
  }).catch((error) => error);
  await jest.advanceTimersByTimeAsync(20_000);
  controller.abort();
  await expect(pending).resolves.toBe(controller.signal.reason);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

it("does not retry after the batch's spend allowance is exhausted", async () => {
  jest.useFakeTimers();
  const runner = jest.fn(waitForAbort);
  const pending = describeImageWithAuxiliaryVision({
    ...descriptorArgs,
    modelRunner: runner,
    canRetry: () => false,
  });
  const assertion = expect(pending).rejects.toBeInstanceOf(
    AuxiliaryVisionTimeoutError,
  );
  await jest.advanceTimersByTimeAsync(20_000);
  await assertion;
  expect(runner).toHaveBeenCalledTimes(1);
});

it("persists successful attachments from a failed batch and reuses them in a new SDK-converted run", async () => {
  const saved = new Map<string, { description: string; model: string }>();
  const cacheDescription: AuxiliaryVisionDescriptionCacheWriter = jest.fn(
    async ({ fileId, description, model }) => {
      saved.set(fileId, { description, model });
    },
  );
  const firstMessages = imageHistory();
  const firstRunner = jest.fn<
    ReturnType<AuxiliaryVisionModelRunner>,
    Parameters<AuxiliaryVisionModelRunner>
  >(async ({ image }) => {
    if (image.includes("/1.png")) throw new Error("Permanent image failure");
    return {
      text: "OCR <evidence>",
      model: AUXILIARY_VISION_SLUG,
      usage: { raw: { cost: 0.001 } },
    };
  });
  const onCost = jest.fn();
  const create = (
    messages: UIMessage[],
    modelRunner: AuxiliaryVisionModelRunner,
  ) =>
    createAbliterationVisionPreprocessor({
      userId: "owner",
      chatId: "chat",
      abortSignal: new AbortController().signal,
      onCost,
      getAttachmentMessages: () => messages,
      cacheDescription,
      describe: (args) =>
        describeImageWithAuxiliaryVision({ ...args, modelRunner }),
    });
  await expect(
    create(
      firstMessages,
      firstRunner,
    )(await convertToModelMessages(firstMessages)),
  ).rejects.toThrow("Image analysis could not be completed");
  expect([...saved.keys()].sort()).toEqual(["file-0", "file-2", "file-3"]);
  expect(onCost).toHaveBeenCalledTimes(3);
  // Simulate the owner-checked reload, including changed signed URLs on a new run.
  const secondMessages = imageHistory();
  for (const part of secondMessages[0].parts) {
    const file = part as { fileId: string; url: string };
    file.url += "?signature=new";
    const cached = saved.get(file.fileId);
    if (cached)
      Object.assign(part, {
        auxiliaryVisionDescription: cached.description,
        auxiliaryVisionModel: cached.model,
      });
  }
  const secondRunner = jest.fn(async () => ({
    text: "Recovered",
    model: AUXILIARY_VISION_SLUG,
    usage: { raw: { cost: 0.001 } },
  }));
  const original = JSON.stringify(secondMessages);
  const output = await create(
    secondMessages,
    secondRunner,
  )(await convertToModelMessages(secondMessages));
  expect(secondRunner).toHaveBeenCalledTimes(2);
  expect(onCost).toHaveBeenCalledTimes(5);
  expect(JSON.stringify(output)).toContain("OCR &lt;evidence&gt;");
  expect(JSON.stringify(secondMessages)).toBe(original);
  expect(saved.size).toBe(5);
});

it("matches SDK-decoded data URLs to owned attachments without trusting SDK cache fields", async () => {
  const messages = imageHistory();
  const first = messages[0].parts[0];
  Object.assign(first, {
    url: "data:image/png;base64,AQID",
    auxiliaryVisionDescription: "Saved image",
    auxiliaryVisionModel: AUXILIARY_VISION_SLUG,
  });
  const describe = jest.fn(async () => ({
    description: "Fresh",
    model: AUXILIARY_VISION_SLUG,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  }));
  const modelMessages = await convertToModelMessages(messages);
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "owner",
    chatId: "chat",
    abortSignal: new AbortController().signal,
    onCost: jest.fn(),
    describe,
    getAttachmentMessages: () => messages,
  });
  expect(JSON.stringify(await preprocess(modelMessages))).toContain(
    "Saved image",
  );
  expect(describe).toHaveBeenCalledTimes(4);
  // No trusted reload: injected provider-message metadata cannot skip image analysis.
  const untrusted = createAbliterationVisionPreprocessor({
    userId: "owner",
    chatId: "chat",
    abortSignal: new AbortController().signal,
    onCost: jest.fn(),
    describe,
  });
  await untrusted(modelMessages);
  expect(describe).toHaveBeenCalledTimes(9);
});

it("bounds all batches by elapsed time and stops queued work", async () => {
  jest.useFakeTimers();
  const messages = imageHistory(40);
  const runner: AuxiliaryVisionModelRunner = ({ abortSignal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", abort);
        resolve({ text: "Description" });
      }, 15_000);
      const abort = () => {
        clearTimeout(timer);
        reject(abortSignal.reason);
      };
      abortSignal.addEventListener("abort", abort, { once: true });
    });
  const describe = jest.fn(
    (args: Parameters<typeof describeImageWithAuxiliaryVision>[0]) =>
      describeImageWithAuxiliaryVision({ ...args, modelRunner: runner }),
  );
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "owner",
    chatId: "chat",
    abortSignal: new AbortController().signal,
    onCost: jest.fn(),
    describe,
  });
  const pending = preprocess(await convertToModelMessages(messages));
  const assertion = expect(pending).rejects.toMatchObject({
    name: "AbliterationVisionError",
    cause: expect.any(AuxiliaryVisionTimeoutError),
  });
  await jest.advanceTimersByTimeAsync(AUXILIARY_VISION_RECOVERY_TIMEOUT_MS);
  await assertion;
  expect(describe).toHaveBeenCalledTimes(32);
  expect(jest.getTimerCount()).toBe(0);
});

it("stops later batches at the spend threshold while settling in-flight charges", async () => {
  const onCost = jest.fn();
  const describe = jest.fn(
    async (args: Parameters<typeof describeImageWithAuxiliaryVision>[0]) => {
      args.onCost?.(AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS);
      return {
        description: "Result",
        model: AUXILIARY_VISION_SLUG,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
    },
  );
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "owner",
    chatId: "chat",
    abortSignal: new AbortController().signal,
    onCost,
    describe,
  });
  await expect(
    preprocess(await convertToModelMessages(imageHistory())),
  ).rejects.toThrow("Image analysis could not be completed");
  expect(describe).toHaveBeenCalledTimes(1);
  expect(onCost).toHaveBeenCalledWith(
    AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS,
  );
});
