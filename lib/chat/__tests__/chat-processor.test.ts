import { describe, it, expect } from "@jest/globals";
import { UIMessage } from "ai";
import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import {
  limitImageParts,
  selectModel,
  getMaxStepsForUser,
  fixIncompleteMessageParts,
} from "../chat-processor";

function makeFilePart(id: string, mediaType = "image/png") {
  return { type: "file", fileId: id, mediaType, name: `${id}.png`, size: 100 };
}

function makeMessage(
  id: string,
  role: "user" | "assistant",
  parts: any[],
): UIMessage {
  return { id, role, parts } as UIMessage;
}

describe("limitImageParts", () => {
  it("should return messages unchanged when under the limit", () => {
    const messages = [
      makeMessage("m1", "user", [
        { type: "text", text: "hello" },
        makeFilePart("f1"),
      ]),
    ];
    const result = limitImageParts(messages);
    expect(result).toBe(messages); // same reference, no changes
  });

  it("should return messages unchanged when exactly at the ask limit (10 images)", () => {
    const parts = Array.from({ length: 10 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages, "ask");
    expect(result).toBe(messages);
  });

  it("should remove oldest images when over the ask limit", () => {
    const parts = Array.from({ length: 15 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages, "ask");

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    expect(remainingFiles).toHaveLength(10);
    // Should keep f5..f14 (the 10 most recent), removing f0..f4
    expect((remainingFiles[0] as any).fileId).toBe("f5");
    expect((remainingFiles[9] as any).fileId).toBe("f14");
  });

  it("should remove oldest images across multiple messages in ask mode", () => {
    // 3 messages with 5 images each = 15 total, should keep last 10
    const messages = Array.from({ length: 3 }, (_, msgIdx) => {
      const parts = Array.from({ length: 5 }, (_, fileIdx) =>
        makeFilePart(`f${msgIdx * 5 + fileIdx}`),
      );
      return makeMessage(`m${msgIdx}`, "user", parts);
    });

    const result = limitImageParts(messages, "ask");

    const allFiles = result.flatMap((msg) =>
      msg.parts.filter((p: any) => p.type === "file"),
    );
    expect(allFiles).toHaveLength(10);
    // Oldest 5 images (f0..f4) from first message should be removed
    expect((allFiles[0] as any).fileId).toBe("f5");
    expect((allFiles[9] as any).fileId).toBe("f14");
  });

  it("should preserve non-file parts when removing images", () => {
    const parts: any[] = [
      { type: "text", text: "check these images" },
      ...Array.from({ length: 12 }, (_, i) => makeFilePart(`f${i}`)),
    ];
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages, "ask");

    const textParts = result[0].parts.filter((p: any) => p.type === "text");
    const fileParts = result[0].parts.filter((p: any) => p.type === "file");

    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).toBe("check these images");
    expect(fileParts).toHaveLength(10);
  });

  it("should handle messages with no parts", () => {
    const messages = [
      { id: "m1", role: "user" } as UIMessage,
      makeMessage("m2", "user", [makeFilePart("f1")]),
    ];
    const result = limitImageParts(messages);
    expect(result).toBe(messages); // under limit, no changes
  });

  it("should only limit images, leaving PDFs and other file types untouched", () => {
    const parts = Array.from({ length: 25 }, (_, i) =>
      makeFilePart(`f${i}`, i % 2 === 0 ? "image/png" : "application/pdf"),
    );
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages, "ask");

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    const images = remainingFiles.filter(
      (p: any) => p.mediaType === "image/png",
    );
    const pdfs = remainingFiles.filter(
      (p: any) => p.mediaType === "application/pdf",
    );

    // All 12 PDFs should remain (odd indices: 1,3,5,...,23 = 12 PDFs)
    expect(pdfs).toHaveLength(12);
    // Only 10 most recent images should remain (even indices: 0,2,4,...,24 = 13 images, keep last 10)
    expect(images).toHaveLength(10);
  });

  it("should not remove any files when all are non-image types", () => {
    const parts = Array.from({ length: 20 }, (_, i) =>
      makeFilePart(`f${i}`, "application/pdf"),
    );
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages);
    expect(result).toBe(messages); // no images, nothing to limit
  });

  it("should allow 20 images in agent mode", () => {
    const parts = Array.from({ length: 20 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages, "agent");
    expect(result).toBe(messages);
  });

  it("should remove oldest images only after the agent limit", () => {
    const parts = Array.from({ length: 25 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages, "agent");

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    expect(remainingFiles).toHaveLength(20);
    expect((remainingFiles[0] as any).fileId).toBe("f5");
    expect((remainingFiles[19] as any).fileId).toBe("f24");
  });
});

// ==========================================================================
// selectModel - Model selection logic
// ==========================================================================
describe("selectModel", () => {
  const paidPlans = ["pro", "pro-plus", "ultra", "team"] as const;
  const selections = [
    undefined,
    "auto",
    "hackerai-standard",
    "hackerai-pro",
    "hackerai-max",
  ] as const;
  const attachments = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const;

  it.each(paidPlans)(
    "rejects every Ask selection for %s before routing",
    (subscription) => {
      for (const selection of selections) {
        for (const [hasImage, hasPdf] of attachments) {
          for (const options of [
            {},
            { directGlmVisionEnabled: true },
            { auxiliaryVisionEnabled: true, extraUsageAvailable: true },
          ]) {
            expect(() =>
              selectModel(
                "ask",
                subscription,
                selection,
                hasImage,
                hasPdf,
                options,
              ),
            ).toThrow(
              expect.objectContaining({
                statusCode: 403,
                cause:
                  "Paid plans use Agent mode. Ask mode is only available on the free plan.",
              }),
            );
          }
        }
      }
    },
  );

  it.each(["ask", "agent"] as const)(
    "preserves Free %s routing and ignores paid tier overrides",
    (mode) => {
      for (const selection of selections) {
        for (const [hasImage, hasPdf] of attachments) {
          expect(selectModel(mode, "free", selection, hasImage, hasPdf)).toBe(
            mode === "ask" ? "ask-model-free-glm" : "model-glm-5.3-flash-agent",
          );
        }
      }
    },
  );

  describe.each(paidPlans)("%s Agent routing", (subscription) => {
    it("uses native DeepSeek Flash for Standard and Pro with all attachments", () => {
      for (const [hasImage, hasPdf] of attachments) {
        for (const options of [
          {},
          { directGlmVisionEnabled: true },
          { auxiliaryVisionEnabled: true },
        ]) {
          expect(
            selectModel(
              "agent",
              subscription,
              "hackerai-standard",
              hasImage,
              hasPdf,
              options,
            ),
          ).toBe(DEEPSEEK_1017_MODEL_KEY);
          expect(
            selectModel(
              "agent",
              subscription,
              "hackerai-pro",
              hasImage,
              hasPdf,
              options,
            ),
          ).toBe(DEEPSEEK_1017_MODEL_KEY);
        }
      }
    });

    it("keeps Auto and default text/PDF routes on DeepSeek and image routes on Grok", () => {
      for (const selection of [undefined, "auto"] as const) {
        for (const [hasImage, hasPdf] of attachments) {
          expect(
            selectModel("agent", subscription, selection, hasImage, hasPdf),
          ).toBe(
            hasImage ? "model-grok-4.5" : "model-deepseek-v4-flash-vision-pro",
          );
        }
      }
    });

    it("preserves direct and auxiliary vision for Auto and default selections", () => {
      for (const selection of [undefined, "auto"] as const) {
        for (const [hasImage, hasPdf] of attachments) {
          expect(
            selectModel("agent", subscription, selection, hasImage, hasPdf, {
              directGlmVisionEnabled: true,
            }),
          ).toBe(
            !hasImage
              ? "model-deepseek-v4-flash-vision-pro"
              : subscription === "pro" || subscription === "pro-plus"
                ? "model-glm-5.3-flash"
                : "model-deepseek-v4-flash-vision",
          );
          expect(
            selectModel("agent", subscription, selection, hasImage, hasPdf, {
              auxiliaryVisionEnabled: true,
            }),
          ).toBe("model-deepseek-v4-flash-vision-pro");
        }
      }
    });

    it("preserves Max entitlement and media routes", () => {
      for (const extraUsageAvailable of [false, true]) {
        for (const [hasImage, hasPdf] of attachments) {
          for (const directGlmVisionEnabled of [false, true]) {
            const maxAllowed = subscription === "ultra" || extraUsageAvailable;
            expect(
              selectModel(
                "agent",
                subscription,
                "hackerai-max",
                hasImage,
                hasPdf,
                {
                  extraUsageAvailable,
                  directGlmVisionEnabled,
                },
              ),
            ).toBe(
              !maxAllowed
                ? DEEPSEEK_1017_MODEL_KEY
                : hasImage
                  ? DEEPSEEK_1017_MODEL_KEY
                  : "model-glm-5.3",
            );
          }
          expect(
            selectModel(
              "agent",
              subscription,
              "hackerai-max",
              hasImage,
              hasPdf,
              {
                extraUsageAvailable,
                auxiliaryVisionEnabled: true,
              },
            ),
          ).toBe(
            subscription === "ultra" || extraUsageAvailable
              ? "model-glm-5.3"
              : DEEPSEEK_1017_MODEL_KEY,
          );
        }
      }
    });
  });
});

// ==========================================================================
// getMaxStepsForUser - Step limits by mode
// ==========================================================================
describe("getMaxStepsForUser", () => {
  it("should return 500 steps for agent mode", () => {
    expect(getMaxStepsForUser("agent")).toBe(500);
  });

  it("should return 15 steps for ask mode", () => {
    expect(getMaxStepsForUser("ask")).toBe(15);
  });
});

// ==========================================================================
// fixIncompleteMessageParts - Fixing incomplete tool invocations on abort
// ==========================================================================
describe("fixIncompleteMessageParts", () => {
  it("should not modify already-complete tool parts", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "output-available",
        input: { title: "Test" },
        output: { message: "Created" },
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toEqual(parts);
  });

  it("should mark incomplete renderable tool with input as aborted", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "input-available",
        input: { title: "Test", content: "Content" },
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("step-start");
    expect(result[1]).toMatchObject({
      type: "tool-create_note",
      toolCallId: "call_1",
      state: "output-error",
      input: { title: "Test", content: "Content" },
      errorText: expect.stringContaining("Execution was interrupted"),
    });
  });

  it("should identify output-limited tools without blaming the user", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-file",
        toolCallId: "call_1",
        state: "input-streaming",
        input: { action: "write", path: "/tmp/result.py" },
      },
    ];

    const result = fixIncompleteMessageParts(parts, {
      logContext: { finishReason: "length" },
    });

    expect(result[1]).toMatchObject({
      type: "tool-file",
      state: "output-error",
      errorText:
        "The response reached its output limit before the tool completed.",
    });
  });

  it("should remove tool parts with input-streaming and no input", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "input-streaming",
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(0);
  });

  it("should remove tool parts with undefined input", () => {
    const parts = [
      { type: "text", text: "Let me help" },
      { type: "step-start" },
      {
        type: "tool-file",
        toolCallId: "call_2",
        state: "input-streaming",
        input: undefined,
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    // Text should remain, step-start and tool should be removed
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
  });

  it("should mark incomplete tool with partial meaningful input as aborted", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "input-streaming",
        input: { title: "Partial" },
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      type: "tool-create_note",
      state: "output-error",
      input: { title: "Partial" },
      errorText: expect.stringContaining("Execution was interrupted"),
    });
  });

  it("should mark incomplete file writes with streamed path metadata as aborted", () => {
    const parts = [
      { type: "step-start" },
      {
        input: {
          action: "write",
          brief: "Test with cloudscraper to handle Cloudflare challenge",
          path: "/home/user/telenet_cloudscraper.py",
        },
        state: "input-streaming",
        toolCallId: "toolu_vrtx_01CY5UvLdoBKwymCRD5TB8r3",
        type: "tool-file",
      },
    ];

    const result = fixIncompleteMessageParts(parts);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      type: "tool-file",
      state: "output-error",
      toolCallId: "toolu_vrtx_01CY5UvLdoBKwymCRD5TB8r3",
      input: {
        action: "write",
        brief: "Test with cloudscraper to handle Cloudflare challenge",
        path: "/home/user/telenet_cloudscraper.py",
      },
      errorText: expect.stringContaining("Execution was interrupted"),
    });
  });

  it("should handle mixed complete and incomplete parts", () => {
    const parts = [
      { type: "step-start" },
      { type: "text", text: "I'll create a note" },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "output-available",
        input: { title: "Done" },
        output: { message: "Created" },
      },
      { type: "step-start" },
      {
        type: "tool-file",
        toolCallId: "call_2",
        state: "input-streaming",
        // No input - interrupted
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    // Should keep first step-start, text, and completed tool; remove second step-start and incomplete tool
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("step-start");
    expect(result[1].type).toBe("text");
    expect(result[2].type).toBe("tool-create_note");
    expect(result[2].state).toBe("output-available");
  });

  it("should preserve existing output on incomplete tool with input", () => {
    const parts = [
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "input-available",
        input: { title: "Test" },
        output: { message: "Partial result" },
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result[0].state).toBe("output-available");
    expect(result[0].output).toEqual({ message: "Partial result" });
  });

  it("should preserve error tool parts", () => {
    const parts = [
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "output-error",
        errorText: "Something went wrong",
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(1);
    expect(result[0].errorText).toBe("Something went wrong");
  });

  // Trailing incomplete step trimming ("must include at least one parts field" fix)
  it("should trim trailing step with only reasoning (no text/tool content)", () => {
    const parts = [
      { type: "step-start" },
      { type: "reasoning", state: "done", text: "Thinking about step 1..." },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "output-available",
        input: { title: "Note" },
        output: { message: "Created" },
      },
      { type: "step-start" },
      {
        type: "reasoning",
        state: "done",
        text: "Thinking about step 2 but interrupted...",
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    // Should keep first step with content, remove trailing step-start + reasoning
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("step-start");
    expect(result[1].type).toBe("reasoning");
    expect(result[2].type).toBe("tool-create_note");
  });

  it("should not trim trailing step that has text content", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-create_note",
        toolCallId: "call_1",
        state: "output-available",
        input: { title: "Note" },
        output: { message: "Created" },
      },
      { type: "step-start" },
      { type: "reasoning", state: "done", text: "Let me explain..." },
      { type: "text", text: "Here is the result." },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(5);
  });

  it("should not trim trailing step that has tool content", () => {
    const parts = [
      { type: "step-start" },
      { type: "reasoning", state: "done", text: "Thinking..." },
      {
        type: "tool-file",
        toolCallId: "call_1",
        state: "output-available",
        input: { action: "read" },
        output: { content: "file data" },
      },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(3);
  });

  it("should trim single step with only reasoning to empty array", () => {
    const parts = [
      { type: "step-start" },
      { type: "reasoning", state: "done", text: "Just thinking..." },
    ];
    const result = fixIncompleteMessageParts(parts);
    expect(result).toHaveLength(0);
  });

  it("should trim trailing step with multiple reasoning parts but no content", () => {
    const parts = [
      { type: "step-start" },
      { type: "text", text: "I found the issue." },
      { type: "step-start" },
      { type: "reasoning", state: "done", text: "First thought..." },
      { type: "reasoning", state: "done", text: "Second thought..." },
    ];
    const result = fixIncompleteMessageParts(parts);
    // Should keep first step, remove trailing step-start + both reasoning parts
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("step-start");
    expect(result[1].type).toBe("text");
  });
});
