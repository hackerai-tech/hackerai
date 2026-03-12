import { describe, it, expect } from "@jest/globals";
import { UIMessage } from "ai";
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

  it("should return messages unchanged when exactly at the limit (10 images)", () => {
    const parts = Array.from({ length: 10 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages);
    expect(result).toBe(messages);
  });

  it("should remove oldest images when over the limit", () => {
    const parts = Array.from({ length: 15 }, (_, i) => makeFilePart(`f${i}`));
    const messages = [makeMessage("m1", "user", parts)];
    const result = limitImageParts(messages);

    const remainingFiles = result[0].parts.filter(
      (p: any) => p.type === "file",
    );
    expect(remainingFiles).toHaveLength(10);
    // Should keep f5..f14 (the 10 most recent), removing f0..f4
    expect((remainingFiles[0] as any).fileId).toBe("f5");
    expect((remainingFiles[9] as any).fileId).toBe("f14");
  });

  it("should remove oldest images across multiple messages", () => {
    // 3 messages with 5 images each = 15 total, should keep last 10
    const messages = Array.from({ length: 3 }, (_, msgIdx) => {
      const parts = Array.from({ length: 5 }, (_, fileIdx) =>
        makeFilePart(`f${msgIdx * 5 + fileIdx}`),
      );
      return makeMessage(`m${msgIdx}`, "user", parts);
    });

    const result = limitImageParts(messages);

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
    const result = limitImageParts(messages);

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
    const result = limitImageParts(messages);

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

    it("should return agent-model for agent-long mode", () => {
      expect(selectModel("agent-long", "pro")).toBe("agent-model");
    });

    it("should return ask-model for ask mode (paid)", () => {
      expect(selectModel("ask", "pro")).toBe("ask-model");
    });

    it("should return ask-model-free for ask mode (free)", () => {
      expect(selectModel("ask", "free")).toBe("ask-model-free");
    });

    it("should return ask-model for ultra subscription", () => {
      expect(selectModel("ask", "ultra")).toBe("ask-model");
    });

    it("should return ask-model for team subscription", () => {
      expect(selectModel("ask", "team")).toBe("ask-model");
    });
  });

  // Model override — enabled for Ask mode (paid users only), always ignored for Agent mode
  describe("model override for ask mode (paid users)", () => {
    it("should use selected model override for ask mode", () => {
      expect(selectModel("ask", "ultra", "sonnet-4.6")).toBe(
        "model-sonnet-4.6",
      );
    });

    it("should use selected model override for team users in ask mode", () => {
      expect(selectModel("ask", "team", "sonnet-4.6")).toBe("model-sonnet-4.6");
    });

    it("should apply all selectable models in ask mode", () => {
      expect(selectModel("ask", "pro", "gemini-3.1-pro")).toBe(
        "model-gemini-3.1-pro",
      );
      expect(selectModel("ask", "pro", "grok-4.1")).toBe("model-grok-4.1");
      expect(selectModel("ask", "pro", "gemini-3-flash")).toBe(
        "model-gemini-3-flash",
      );
      expect(selectModel("ask", "pro", "gpt-5.4")).toBe("model-gpt-5.4");
    });
  });

  // Agent mode always ignores model override
  describe("model override ignored for agent mode", () => {
    it("should ignore selected model override for agent mode", () => {
      expect(selectModel("agent", "pro", "sonnet-4.6")).toBe("agent-model");
    });

    it("should ignore selected model override for agent-long mode", () => {
      expect(selectModel("agent-long", "pro", "sonnet-4.6")).toBe(
        "agent-model",
      );
    });

    it("should ignore all selectable models in agent mode", () => {
      expect(selectModel("agent", "pro", "gemini-3.1-pro")).toBe("agent-model");
      expect(selectModel("agent", "pro", "grok-4.1")).toBe("agent-model");
      expect(selectModel("agent", "pro", "gemini-3-flash")).toBe("agent-model");
      expect(selectModel("agent", "pro", "gpt-5.4")).toBe("agent-model");
    });
  });

  // Free user guard
  describe("free user guard", () => {
    it("should ignore model override for free users in agent mode", () => {
      expect(selectModel("agent", "free", "sonnet-4.6")).toBe("agent-model");
    });

    it("should ignore model override for free users in ask mode", () => {
      expect(selectModel("ask", "free", "sonnet-4.6")).toBe("ask-model-free");
    });
  });

  // "auto" override
  describe("auto override", () => {
    it("should treat 'auto' as no override in agent mode", () => {
      expect(selectModel("agent", "pro", "auto")).toBe("agent-model");
    });

    it("should treat 'auto' as no override in ask mode", () => {
      expect(selectModel("ask", "pro", "auto")).toBe("ask-model");
    });
  });

  // Undefined override
  describe("undefined override", () => {
    it("should use default when override is undefined", () => {
      expect(selectModel("agent", "pro", undefined)).toBe("agent-model");
      expect(selectModel("ask", "pro", undefined)).toBe("ask-model");
    });
  });
});

// ==========================================================================
// getMaxStepsForUser - Step limits by mode and subscription
// ==========================================================================
describe("getMaxStepsForUser", () => {
  it("should return 100 steps for agent mode", () => {
    expect(getMaxStepsForUser("agent", "free")).toBe(100);
    expect(getMaxStepsForUser("agent", "pro")).toBe(100);
    expect(getMaxStepsForUser("agent", "ultra")).toBe(100);
  });

  it("should return 100 steps for agent-long mode", () => {
    expect(getMaxStepsForUser("agent-long", "pro")).toBe(100);
  });

  it("should return 5 steps for free ask mode", () => {
    expect(getMaxStepsForUser("ask", "free")).toBe(5);
  });

  it("should return 15 steps for paid ask mode", () => {
    expect(getMaxStepsForUser("ask", "pro")).toBe(15);
    expect(getMaxStepsForUser("ask", "ultra")).toBe(15);
    expect(getMaxStepsForUser("ask", "team")).toBe(15);
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

  it("should remove incomplete tool with input but no output", () => {
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
    // Tool never executed (no output), so remove it and its step-start
    expect(result).toHaveLength(0);
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

  it("should remove incomplete tool with partial input but no output", () => {
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
    // Tool never produced output, so remove entirely
    expect(result).toHaveLength(0);
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
