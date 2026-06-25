import { describe, it, expect } from "@jest/globals";
import { UIMessage } from "ai";
import {
  limitImageParts,
  selectModel,
  getMaxStepsForUser,
  fixIncompleteMessageParts,
  addAuthMessage,
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
  // Default model selection by mode
  describe("default models (no override)", () => {
    it("should return agent-model for agent mode", () => {
      expect(selectModel("agent", "pro")).toBe("agent-model");
    });

    it("should return DeepSeek V4 Pro for paid ask with no image/PDF", () => {
      expect(selectModel("ask", "pro")).toBe("model-deepseek-v4-pro");
    });

    it("should return ask-model (Grok) for paid ask when an image is attached", () => {
      expect(selectModel("ask", "pro", undefined, true, false)).toBe(
        "ask-model",
      );
    });

    it("should return ask-model (Grok) for paid ask when a PDF is attached", () => {
      expect(selectModel("ask", "pro", undefined, false, true)).toBe(
        "ask-model",
      );
    });

    it("should prefer ask-model (Grok) when paid ask has both image and PDF attachments", () => {
      expect(selectModel("ask", "pro", undefined, true, true)).toBe(
        "ask-model",
      );
    });

    it("should return ask-model-free for ask mode (free)", () => {
      expect(selectModel("ask", "free")).toBe("ask-model-free");
    });

    it("should return DeepSeek V4 Pro for ultra subscription with no image/PDF", () => {
      expect(selectModel("ask", "ultra")).toBe("model-deepseek-v4-pro");
    });

    it("should return DeepSeek V4 Pro for team subscription with no image/PDF", () => {
      expect(selectModel("ask", "team")).toBe("model-deepseek-v4-pro");
    });
  });

  // Tier override — Standard is content-aware in ask mode; Max maps to Opus in both modes
  describe("tier override for ask mode (paid users)", () => {
    it("should map HackerAI Pro to Sonnet 4.6 for text-only ask mode", () => {
      expect(selectModel("ask", "ultra", "hackerai-pro")).toBe(
        "model-sonnet-4.6",
      );
    });

    it("should map HackerAI Pro to Sonnet 4.6 for team users", () => {
      expect(selectModel("ask", "team", "hackerai-pro")).toBe(
        "model-sonnet-4.6",
      );
    });

    it("should keep HackerAI Pro on Sonnet 4.6 when an image is attached", () => {
      expect(selectModel("ask", "pro", "hackerai-pro", true, false)).toBe(
        "model-sonnet-4.6",
      );
    });

    it("should map HackerAI Standard to DeepSeek V4 Pro when no image/PDF", () => {
      expect(selectModel("ask", "pro", "hackerai-standard")).toBe(
        "model-deepseek-v4-pro",
      );
    });

    it("should promote HackerAI Standard to Grok 4.3 when an image is attached", () => {
      expect(selectModel("ask", "pro", "hackerai-standard", true, false)).toBe(
        "model-grok-4.3",
      );
    });

    it("should promote HackerAI Standard to Grok 4.3 when a PDF is attached", () => {
      expect(selectModel("ask", "pro", "hackerai-standard", false, true)).toBe(
        "model-grok-4.3",
      );
    });

    it("should prefer Grok 4.3 for HackerAI Standard when image and PDF are both attached", () => {
      expect(selectModel("ask", "pro", "hackerai-standard", true, true)).toBe(
        "model-grok-4.3",
      );
    });

    it("should map HackerAI Max to Opus 4.6", () => {
      expect(selectModel("ask", "pro", "hackerai-max")).toBe("model-opus-4.6");
    });
  });

  // Agent mode — Standard resolves to Kimi instead of Gemini
  describe("tier override in agent mode", () => {
    it("should map HackerAI Standard to Kimi K2.7 Code in agent mode", () => {
      expect(selectModel("agent", "pro", "hackerai-standard")).toBe(
        "model-kimi-k2.7-code",
      );
    });

    it("should map HackerAI Pro to Sonnet 4.6 in agent mode", () => {
      expect(selectModel("agent", "pro", "hackerai-pro")).toBe(
        "model-sonnet-4.6",
      );
    });

    it("should map HackerAI Max to Opus 4.6 in agent mode", () => {
      expect(selectModel("agent", "pro", "hackerai-max")).toBe(
        "model-opus-4.6",
      );
    });

    it("should default to agent-model when no model selected", () => {
      expect(selectModel("agent", "pro")).toBe("agent-model");
      expect(selectModel("agent", "pro", "auto")).toBe("agent-model");
    });
  });

  // Free user guard
  describe("free user guard", () => {
    it("should ignore tier override for free users in agent mode", () => {
      expect(selectModel("agent", "free", "hackerai-pro")).toBe(
        "agent-model-free",
      );
    });

    it("should ignore tier override for free users in ask mode", () => {
      expect(selectModel("ask", "free", "hackerai-pro")).toBe("ask-model-free");
    });

    it("should keep free ask Standard on the free DeepSeek route", () => {
      expect(selectModel("ask", "free", "hackerai-standard")).toBe(
        "ask-model-free",
      );
    });
  });

  // "auto" override
  describe("auto override", () => {
    it("should treat 'auto' as no override in agent mode", () => {
      expect(selectModel("agent", "pro", "auto")).toBe("agent-model");
    });

    it("should treat 'auto' as no override in paid ask mode (text-only → DeepSeek Pro)", () => {
      expect(selectModel("ask", "pro", "auto")).toBe("model-deepseek-v4-pro");
    });

    it("should treat 'auto' as no override in ask mode with image -> Gemini", () => {
      expect(selectModel("ask", "pro", "auto", true, false)).toBe("ask-model");
    });

    it("should treat 'auto' as no override in ask mode with PDF -> Gemini", () => {
      expect(selectModel("ask", "pro", "auto", false, true)).toBe("ask-model");
    });
  });

  // Undefined override
  describe("undefined override", () => {
    it("should use default when override is undefined", () => {
      expect(selectModel("agent", "pro", undefined)).toBe("agent-model");
      expect(selectModel("ask", "pro", undefined)).toBe(
        "model-deepseek-v4-pro",
      );
      expect(selectModel("ask", "pro", undefined, true, false)).toBe(
        "ask-model",
      );
      expect(selectModel("ask", "pro", undefined, false, true)).toBe(
        "ask-model",
      );
    });
  });
});

// ==========================================================================
// getMaxStepsForUser - Step limits by mode and subscription
// ==========================================================================
describe("getMaxStepsForUser", () => {
  it("should return 100 steps for agent mode (all tiers)", () => {
    expect(getMaxStepsForUser("agent", "free")).toBe(100);
    expect(getMaxStepsForUser("agent", "pro")).toBe(100);
    expect(getMaxStepsForUser("agent", "ultra")).toBe(100);
    expect(getMaxStepsForUser("agent", "team")).toBe(100);
  });

  it("should return 15 steps for free ask mode", () => {
    expect(getMaxStepsForUser("ask", "free")).toBe(15);
  });

  it("should return 100 steps for paid ask mode", () => {
    expect(getMaxStepsForUser("ask", "pro")).toBe(100);
    expect(getMaxStepsForUser("ask", "ultra")).toBe(100);
    expect(getMaxStepsForUser("ask", "team")).toBe(100);
  });
});

describe("addAuthMessage", () => {
  it("uses the moderation-detected language for the authorization text", () => {
    const messages = [
      makeMessage("m1", "user", [{ type: "text", text: "Escanea mi API" }]),
    ];

    addAuthMessage(messages, "es");

    expect((messages[0].parts[0] as any).text).toContain(
      "Tengo permiso y estoy autorizado",
    );
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
      errorText: "Stopped by user before the tool completed.",
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
      errorText: "Stopped by user before the tool completed.",
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
      errorText: "Stopped by user before the tool completed.",
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

  // Trailing incomplete step trimming (Gemini "must include at least one parts field" fix)
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
