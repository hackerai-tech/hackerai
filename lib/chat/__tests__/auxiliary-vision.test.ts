jest.mock("server-only", () => ({}));

import {
  AUXILIARY_VISION_SLUG,
  DEEPSEEK_V4_FLASH_VISION_SLUG,
  GLM_5_3_FLASH_SLUG,
} from "@/lib/ai/providers";
import {
  AUXILIARY_VISION_MAX_CONCURRENCY,
  AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS,
  AUXILIARY_VISION_RECOVERY_TIMEOUT_MS,
  AUXILIARY_VISION_PROVIDER_OPTIONS,
  createVisionSummaryRecoveryController,
  describeImageAttachmentsWithAuxiliaryVision,
  describeImageWithAuxiliaryVision,
  type AuxiliaryVisionModelRunner,
} from "@/lib/chat/auxiliary-vision";

describe("auxiliary vision", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("uses MiniMax only for the final vision-summary recovery", () => {
    expect(AUXILIARY_VISION_PROVIDER_OPTIONS).toEqual({
      openrouter: {
        reasoning: { enabled: false },
        provider: { sort: "latency", data_collection: "deny" },
      },
    });
    expect(AUXILIARY_VISION_SLUG).toBe("minimax/minimax-m3");
  });

  it("prefixes sandbox base64, records cost, and returns text", async () => {
    const modelRunner = jest.fn(async () => ({
      text: "  A terminal shows an exact 403 error.  ",
      usage: {
        inputTokens: 120,
        outputTokens: 12,
        raw: { cost: 0.004 },
      },
    })) as jest.MockedFunction<AuxiliaryVisionModelRunner>;
    const onCost = jest.fn();

    const result = await describeImageWithAuxiliaryVision({
      image: "aW1hZ2U=",
      mediaType: "image/png",
      filename: "screen.png",
      source: "file_view",
      onCost,
      modelRunner,
    });

    expect(modelRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "data:image/png;base64,aW1hZ2U=",
        mediaType: "image/png",
        filename: "screen.png",
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(onCost).toHaveBeenCalledWith(0.004);
    expect(result).toMatchObject({
      description: "A terminal shows an exact 403 error.",
      inputTokens: 120,
      outputTokens: 12,
      costDollars: 0.004,
    });
  });

  it.each([DEEPSEEK_V4_FLASH_VISION_SLUG, GLM_5_3_FLASH_SLUG])(
    "records an unexpected summary model %s",
    async (fallbackModel) => {
      const result = await describeImageWithAuxiliaryVision({
        image: "aW1hZ2U=",
        mediaType: "image/png",
        source: "attachment",
        modelRunner: async () => ({
          text: "Fallback description",
          model: fallbackModel,
        }),
      });

      expect(result.model).toBe(fallbackModel);
      const payload = JSON.parse(
        (console.info as jest.Mock).mock.calls[0][0] as string,
      );
      expect(payload).toMatchObject({
        model: fallbackModel,
        fallback_served: true,
      });
    },
  );

  it("activates MiniMax summary recovery once with bounded diagnostics", () => {
    const controller = createVisionSummaryRecoveryController({
      available: true,
      service: "chat-handler",
      requestId: "request-1",
      userId: "user-1",
      chatId: "chat-1",
      triggerRunId: "run-1",
    });
    const providerError = new Error("sensitive provider details");

    expect(
      controller.activate({ error: providerError, source: "attachment" }),
    ).toBe(true);
    expect(controller.isEnabled()).toBe(true);
    expect(
      controller.activate({ error: providerError, source: "file_view" }),
    ).toBe(false);

    expect(console.warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      (console.warn as jest.Mock).mock.calls[0][0] as string,
    );
    expect(payload).toMatchObject({
      event: "vision_summary_recovery_activated",
      service: "chat-handler",
      request_id: "request-1",
      user_id: "user-1",
      chat_id: "chat-1",
      trigger_run_id: "run-1",
      source: "attachment",
      fallback_route: "minimax_vision_summary",
      failure_reason: "provider_error",
      error_name: "Error",
      failed_image_count: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("sensitive provider details");
  });

  it("does not activate failover for a user cancellation", () => {
    const controller = createVisionSummaryRecoveryController({
      available: true,
      service: "agent-long",
      isUserAborted: () => true,
    });

    expect(
      controller.activate({
        error: new DOMException("Stopped", "AbortError"),
        source: "attachment",
      }),
    ).toBe(false);
    expect(controller.isEnabled()).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("classifies a descriptor timeout without logging its message", () => {
    const controller = createVisionSummaryRecoveryController({
      available: true,
      service: "agent-long",
    });

    controller.activate({
      error: new AggregateError([
        new DOMException("provider timeout details", "AbortError"),
      ]),
      source: "attachment",
    });

    const payload = JSON.parse(
      (console.warn as jest.Mock).mock.calls[0][0] as string,
    );
    expect(payload).toMatchObject({
      service: "agent-long",
      failure_reason: "timeout",
      error_name: "AggregateError",
      failed_image_count: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("provider timeout details");
  });

  it("replaces image files with untrusted descriptions and keeps other parts", async () => {
    const modelRunner = jest.fn(async () => ({
      text: "Visible login form with a red invalid-password warning.",
      usage: { raw: { cost: 0.003 } },
    })) as jest.MockedFunction<AuxiliaryVisionModelRunner>;
    const onCost = jest.fn();

    const messages = await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            { type: "text", text: "What failed?" },
            {
              type: "file",
              mediaType: "image/png",
              filename: 'login"screen.png',
              url: "https://files.example/image.png",
            },
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "report.pdf",
              url: "data:application/pdf;base64,cGRm",
            },
          ],
        },
      ],
      onCost,
      modelRunner,
    });

    expect(messages[0].parts).toEqual([
      { type: "text", text: "What failed?" },
      {
        type: "text",
        text: '<image_description filename="login&quot;screen.png" trust="untrusted">\nVisible login form with a red invalid-password warning.\n</image_description>',
      },
      expect.objectContaining({
        type: "file",
        mediaType: "application/pdf",
      }),
    ]);
    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.003);
  });

  it("reuses matching owned-file descriptions without another model call", async () => {
    const modelRunner =
      jest.fn() as jest.MockedFunction<AuxiliaryVisionModelRunner>;

    const messages = await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            {
              type: "file",
              fileId: "file-1",
              mediaType: "image/png",
              filename: "cached.png",
              url: "https://files.example/image.png",
              auxiliaryVisionDescription: "Cached & exact <screen> text",
              auxiliaryVisionModel: AUXILIARY_VISION_SLUG,
            } as never,
          ],
        },
      ],
      modelRunner,
    });

    expect(modelRunner).not.toHaveBeenCalled();
    expect(messages[0].parts[0]).toEqual({
      type: "text",
      text: '<image_description filename="cached.png" trust="untrusted">\nCached &amp; exact &lt;screen&gt; text\n</image_description>',
    });
  });

  it.each([DEEPSEEK_V4_FLASH_VISION_SLUG, GLM_5_3_FLASH_SLUG])(
    "reuses owned-file descriptions generated by fallback %s",
    async (fallbackModel) => {
      const modelRunner =
        jest.fn() as jest.MockedFunction<AuxiliaryVisionModelRunner>;

      const messages = await describeImageAttachmentsWithAuxiliaryVision({
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [
              {
                type: "file",
                fileId: "file-1",
                mediaType: "image/png",
                filename: "cached.png",
                url: "https://files.example/image.png",
                auxiliaryVisionDescription: "Fallback description",
                auxiliaryVisionModel: fallbackModel,
              } as never,
            ],
          },
        ],
        modelRunner,
      });

      expect(modelRunner).not.toHaveBeenCalled();
      expect(messages[0].parts[0]).toEqual({
        type: "text",
        text: '<image_description filename="cached.png" trust="untrusted">\nFallback description\n</image_description>',
      });
    },
  );

  it("does not trust matching cache metadata without an owned file ID", async () => {
    const modelRunner = jest.fn(async () => ({
      text: "Server-generated description",
    })) as jest.MockedFunction<AuxiliaryVisionModelRunner>;

    const messages = await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "image/png",
              url: "https://files.example/unowned.png",
              auxiliaryVisionDescription: "Client-supplied description",
              auxiliaryVisionModel: AUXILIARY_VISION_SLUG,
            } as never,
          ],
        },
      ],
      modelRunner,
    });

    expect(modelRunner).toHaveBeenCalledTimes(1);
    expect(messages[0].parts[0]).toEqual({
      type: "text",
      text: '<image_description trust="untrusted">\nServer-generated description\n</image_description>',
    });
  });

  it("persists a new owned-file description for later turns", async () => {
    const cacheDescription = jest.fn(async () => undefined);
    await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            {
              type: "file",
              fileId: "file-1",
              mediaType: "image/png",
              filename: "new.png",
              url: "https://files.example/image.png",
            } as never,
          ],
        },
      ],
      userId: "user-1",
      cacheDescription,
      modelRunner: async () => ({ text: "New description" }),
    });

    expect(cacheDescription).toHaveBeenCalledWith({
      userId: "user-1",
      fileId: "file-1",
      description: "New description",
      model: AUXILIARY_VISION_SLUG,
    });
  });

  it("bounds concurrent attachment descriptions", async () => {
    let active = 0;
    let maxActive = 0;
    const modelRunner = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { text: "Bounded description" };
    }) as jest.MockedFunction<AuxiliaryVisionModelRunner>;

    await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: Array.from({ length: 6 }, (_, index) => ({
            type: "file" as const,
            mediaType: "image/png",
            filename: `image-${index}.png`,
            url: `https://files.example/image-${index}.png`,
          })),
        },
      ],
      modelRunner,
    });

    expect(modelRunner).toHaveBeenCalledTimes(6);
    expect(maxActive).toBeLessThanOrEqual(AUXILIARY_VISION_MAX_CONCURRENCY);
  });

  it.each([10, 11, 23])(
    "describes all %i images across history without changing stored messages",
    async (count) => {
      const original = Array.from({ length: count }, (_, index) => ({
        id: `message-${index}`,
        role: "user" as const,
        parts: [
          { type: "text" as const, text: `Check screenshot ${index}` },
          {
            type: "file" as const,
            mediaType: "image/png",
            filename: `screen-${index}.png`,
            url: `https://files.example/image-${index}.png`,
          },
        ],
      }));
      const modelRunner = jest.fn(async ({ filename }) => ({
        text: `Exact OCR for ${filename}: status=403 & retry=0`,
        usage: { raw: { cost: 0.001 } },
      })) as jest.MockedFunction<AuxiliaryVisionModelRunner>;
      const onCost = jest.fn();
      const messages = await describeImageAttachmentsWithAuxiliaryVision({
        messages: original,
        modelRunner,
        onCost,
      });

      expect(modelRunner).toHaveBeenCalledTimes(count);
      expect(messages).toHaveLength(count);
      messages.forEach((message, index) => {
        expect(message.parts).toEqual([
          original[index].parts[0],
          {
            type: "text",
            text: `<image_description filename="screen-${index}.png" trust="untrusted">\nExact OCR for screen-${index}.png: status=403 &amp; retry=0\n</image_description>`,
          },
        ]);
        expect(original[index].parts[1].type).toBe("file");
      });
      expect(onCost).toHaveBeenCalledTimes(1);
      expect(onCost.mock.calls[0][0]).toBeCloseTo(count * 0.001);
    },
  );

  const imageHistory = (count: number) => [
    {
      id: "image-history",
      role: "user" as const,
      parts: Array.from({ length: count }, (_, index) => ({
        type: "file" as const,
        mediaType: "image/png",
        filename: `image-${index}.png`,
        url: `https://files.example/image-${index}.png`,
      })),
    },
  ];

  it("describes repeated images once and preserves every occurrence", async () => {
    const messages = imageHistory(23);
    messages[0].parts = messages[0].parts.map((part) => ({
      ...part,
      url: "https://files.example/shared.png",
    }));
    const modelRunner = jest.fn(async () => ({
      text: "Shared screenshot",
      usage: { raw: { cost: 0.004 } },
    }));
    const onCost = jest.fn();
    const result = await describeImageAttachmentsWithAuxiliaryVision({
      messages,
      modelRunner,
      onCost,
    });
    expect(modelRunner).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.004);
    expect(result[0].parts).toHaveLength(23);
    expect(result[0].parts.every((part) => part.type === "text")).toBe(true);
  });

  it("does not start provider work for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const modelRunner = jest.fn();
    await expect(
      describeImageAttachmentsWithAuxiliaryVision({
        messages: imageHistory(23),
        modelRunner,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(modelRunner).not.toHaveBeenCalled();
  });

  it("cancels in-flight work and stops dispatching queued images", async () => {
    const controller = new AbortController();
    const modelRunner = jest.fn(
      ({ abortSignal }) =>
        new Promise<never>((_, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        }),
    ) as jest.MockedFunction<AuxiliaryVisionModelRunner>;
    const pending = describeImageAttachmentsWithAuxiliaryVision({
      messages: imageHistory(23),
      modelRunner,
      abortSignal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    expect(modelRunner).toHaveBeenCalledTimes(AUXILIARY_VISION_MAX_CONCURRENCY);
    expect(
      modelRunner.mock.calls.every(([args]) => args.abortSignal.aborted),
    ).toBe(true);
  });

  it("bounds the whole queue even when each image finishes within its own timeout", async () => {
    jest.useFakeTimers();
    const onCost = jest.fn();
    const modelRunner = jest.fn(
      ({ abortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            abortSignal.removeEventListener("abort", abort);
            resolve({ text: "Description", usage: { raw: { cost: 0.001 } } });
          }, 15_000);
          const abort = () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          };
          abortSignal.addEventListener("abort", abort, { once: true });
        }),
    ) as jest.MockedFunction<AuxiliaryVisionModelRunner>;
    const pending = describeImageAttachmentsWithAuxiliaryVision({
      messages: imageHistory(40),
      modelRunner,
      onCost,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await jest.advanceTimersByTimeAsync(AUXILIARY_VISION_RECOVERY_TIMEOUT_MS);
    await rejection;
    expect(modelRunner).toHaveBeenCalledTimes(24);
    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost.mock.calls[0][0]).toBeCloseTo(0.021);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("stops new calls at the spend threshold but accounts for all in-flight results", async () => {
    const onCost = jest.fn();
    const modelRunner = jest.fn(async () => ({
      text: "Description",
      usage: { raw: { cost: AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS } },
    }));
    await expect(
      describeImageAttachmentsWithAuxiliaryVision({
        messages: imageHistory(23),
        modelRunner,
        onCost,
      }),
    ).rejects.toThrow("Auxiliary vision failed");
    expect(modelRunner).toHaveBeenCalledTimes(AUXILIARY_VISION_MAX_CONCURRENCY);
    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost.mock.calls[0][0]).toBeCloseTo(
      AUXILIARY_VISION_MAX_CONCURRENCY *
        AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS,
    );
  });

  it("settles all calls and caches successes before reporting a partial failure", async () => {
    const cacheDescription = jest.fn(async () => undefined);
    const onCost = jest.fn();
    const modelRunner = jest.fn(async ({ filename }) => {
      if (filename === "bad.png") throw new Error("provider failed");
      return {
        text: "Successful description",
        usage: { raw: { cost: 0.004 } },
      };
    }) as jest.MockedFunction<AuxiliaryVisionModelRunner>;

    await expect(
      describeImageAttachmentsWithAuxiliaryVision({
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [
              {
                type: "file",
                fileId: "file-good",
                mediaType: "image/png",
                filename: "good.png",
                url: "https://files.example/good.png",
              } as never,
              {
                type: "file",
                fileId: "file-bad",
                mediaType: "image/png",
                filename: "bad.png",
                url: "https://files.example/bad.png",
              } as never,
            ],
          },
        ],
        userId: "user-1",
        chatId: "chat-1",
        triggerRunId: "run-1",
        requestId: "run-1",
        cacheDescription,
        onCost,
        modelRunner,
      }),
    ).rejects.toThrow("failed for 1 image request");

    expect(modelRunner).toHaveBeenCalledTimes(2);
    expect(cacheDescription).toHaveBeenCalledTimes(1);
    expect(cacheDescription).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-good" }),
    );
    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.004);
    const failedEvent = (console.warn as jest.Mock).mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find(
        (payload) => payload.event === "auxiliary_vision_description_failed",
      );
    expect(failedEvent).toMatchObject({
      request_id: "run-1",
      user_id: "user-1",
      chat_id: "chat-1",
      trigger_run_id: "run-1",
      source: "attachment",
    });
  });

  it("accounts for a billed response even when its description is empty", async () => {
    const onCost = jest.fn();
    await expect(
      describeImageWithAuxiliaryVision({
        image: "data:image/png;base64,aW1hZ2U=",
        mediaType: "image/png",
        source: "attachment",
        onCost,
        modelRunner: async () => ({
          text: "   ",
          usage: { raw: { cost: 0.004 } },
        }),
      }),
    ).rejects.toThrow("empty description");
    expect(onCost).toHaveBeenCalledWith(0.004);
  });
});
