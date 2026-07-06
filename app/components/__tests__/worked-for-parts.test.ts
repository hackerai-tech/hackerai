import {
  isExpandableWorkedForPart,
  splitWorkedForParts,
} from "../worked-for-parts";
import type { ChatMessage } from "@/types";

const part = (
  type: string,
  extra: Record<string, unknown> = {},
): ChatMessage["parts"][number] =>
  ({
    type,
    ...extra,
  }) as ChatMessage["parts"][number];

describe("splitWorkedForParts", () => {
  it("keeps tool work collapsed and trailing answer text visible", () => {
    const tool = part("tool-shell", { input: "ran command" });
    const text = part("text", { text: "final answer" });

    const result = splitWorkedForParts([tool, text]);

    expect(result.fileParts).toEqual([]);
    expect(result.nonFileParts).toEqual([tool, text]);
    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([text]);
  });

  it("treats stopped tool-only messages as work with no visible answer", () => {
    const tool = part("tool-shell", { input: "ran command" });

    const result = splitWorkedForParts([tool]);

    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([]);
  });

  it("ignores trailing stream metadata after regenerated answer text", () => {
    const tool = part("tool-shell", { input: "ran command" });
    const text = part("text", { text: "regenerated final answer" });
    const metadata = part("data-context-usage", { data: {} });

    const result = splitWorkedForParts([tool, text, metadata]);

    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([text]);
  });

  it("does not ignore rendered data-terminal parts at the tail", () => {
    const text = part("text", { text: "intermediate text" });
    const terminal = part("data-terminal", {
      data: { terminal: "output", toolCallId: "tool-1" },
    });

    const result = splitWorkedForParts([text, terminal]);

    expect(result.workParts).toEqual([text, terminal]);
    expect(result.trailingTextParts).toEqual([]);
  });

  it("separates file parts from worked-for parts", () => {
    const file = part("file", { url: "https://example.com/file.txt" });
    const tool = part("tool-shell", { input: "ran command" });
    const text = part("text", { text: "final answer" });

    const result = splitWorkedForParts([file, tool, text]);

    expect(result.fileParts).toEqual([file]);
    expect(result.nonFileParts).toEqual([tool, text]);
    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([text]);
  });
});

describe("isExpandableWorkedForPart", () => {
  it("treats tool parts and rendered tool output as expandable work", () => {
    expect(isExpandableWorkedForPart(part("tool-shell"))).toBe(true);
    expect(
      isExpandableWorkedForPart(
        part("data-terminal", {
          data: { terminal: "output", toolCallId: "tool-1" },
        }),
      ),
    ).toBe(true);
    expect(isExpandableWorkedForPart(part("data-summarization"))).toBe(true);
    expect(isExpandableWorkedForPart(part("reasoning"))).toBe(true);
  });

  it("does not treat stream metadata as expandable work", () => {
    expect(isExpandableWorkedForPart(part("step-start"))).toBe(false);
    expect(isExpandableWorkedForPart(part("data-context-usage"))).toBe(false);
  });
});
