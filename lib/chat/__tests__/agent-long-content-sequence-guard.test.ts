import { describe, expect, it } from "@jest/globals";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { createContentSequenceGuard } from "../agent-long-content-sequence-guard";

describe("createContentSequenceGuard", () => {
  it.each(["text", "reasoning"] as const)(
    "keeps a valid %s start, delta, and end sequence",
    (partType) => {
      const guard = createContentSequenceGuard();

      expect(
        guard.shouldDrop({ type: `${partType}-start`, id: "part-1" }),
      ).toBe(false);
      expect(
        guard.shouldDrop({ type: `${partType}-delta`, id: "part-1" }),
      ).toBe(false);
      expect(guard.shouldDrop({ type: `${partType}-end`, id: "part-1" })).toBe(
        false,
      );
    },
  );

  it.each(["text", "reasoning"] as const)(
    "drops %s deltas and ends that have no matching start",
    (partType) => {
      const guard = createContentSequenceGuard();

      expect(
        guard.shouldDrop({ type: `${partType}-delta`, id: "missing" }),
      ).toBe(true);
      expect(guard.shouldDrop({ type: `${partType}-end`, id: "missing" })).toBe(
        true,
      );
    },
  );

  it.each(["text", "reasoning"] as const)(
    "drops duplicate %s starts and ends",
    (partType) => {
      const guard = createContentSequenceGuard();

      expect(
        guard.shouldDrop({ type: `${partType}-start`, id: "part-1" }),
      ).toBe(false);
      expect(
        guard.shouldDrop({ type: `${partType}-start`, id: "part-1" }),
      ).toBe(true);
      expect(guard.shouldDrop({ type: `${partType}-end`, id: "part-1" })).toBe(
        false,
      );
      expect(guard.shouldDrop({ type: `${partType}-end`, id: "part-1" })).toBe(
        true,
      );
    },
  );

  it("tracks text and reasoning IDs independently", () => {
    const guard = createContentSequenceGuard();

    expect(guard.shouldDrop({ type: "text-start", id: "part-1" })).toBe(false);
    expect(guard.shouldDrop({ type: "reasoning-start", id: "part-1" })).toBe(
      false,
    );
    expect(guard.shouldDrop({ type: "text-end", id: "part-1" })).toBe(false);
    expect(guard.shouldDrop({ type: "reasoning-delta", id: "part-1" })).toBe(
      false,
    );
    expect(guard.shouldDrop({ type: "reasoning-end", id: "part-1" })).toBe(
      false,
    );
  });

  it.each(["finish-step", "finish", "abort", "error"])(
    "resets active content parts at the %s boundary",
    (boundaryType) => {
      const guard = createContentSequenceGuard();

      guard.shouldDrop({ type: "text-start", id: "text-1" });
      guard.shouldDrop({ type: "reasoning-start", id: "reasoning-1" });

      expect(guard.shouldDrop({ type: boundaryType })).toBe(false);
      expect(guard.shouldDrop({ type: "text-end", id: "text-1" })).toBe(true);
      expect(
        guard.shouldDrop({ type: "reasoning-delta", id: "reasoning-1" }),
      ).toBe(true);
    },
  );

  it("leaves unrelated chunks alone", () => {
    const guard = createContentSequenceGuard();

    expect(guard.shouldDrop({ type: "tool-output-available" })).toBe(false);
    expect(guard.shouldDrop({ type: "message-metadata" })).toBe(false);
  });

  it("keeps replayed chunks valid for the AI SDK UI message parser", async () => {
    const originalStructuredClone = Object.getOwnPropertyDescriptor(
      globalThis,
      "structuredClone",
    );
    Object.defineProperty(globalThis, "structuredClone", {
      configurable: true,
      value: <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
    });

    const guard = createContentSequenceGuard();
    const replayedChunks: UIMessageChunk[] = [
      { type: "text-end", id: "orphaned-text" },
      { type: "text-start", id: "valid-text" },
      { type: "text-delta", id: "valid-text", delta: "Recovered" },
      { type: "text-end", id: "valid-text" },
    ];
    const filteredChunks = replayedChunks.filter(
      (chunk) => !guard.shouldDrop(chunk),
    );
    const parseErrors: unknown[] = [];
    const parsedMessages = readUIMessageStream({
      stream: new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of filteredChunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      onError: (error) => parseErrors.push(error),
      terminateOnError: true,
    });

    let finalMessage;
    try {
      for await (const message of parsedMessages) finalMessage = message;
    } finally {
      if (originalStructuredClone) {
        Object.defineProperty(
          globalThis,
          "structuredClone",
          originalStructuredClone,
        );
      } else {
        Reflect.deleteProperty(globalThis, "structuredClone");
      }
    }

    expect(parseErrors).toEqual([]);
    expect(finalMessage?.parts).toEqual([
      { type: "text", text: "Recovered", state: "done" },
    ]);
  });
});
