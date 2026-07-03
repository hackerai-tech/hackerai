import { describe, expect, it } from "@jest/globals";

import {
  isIncompletePostSummarizationStop,
  isPostSummarizationFillerText,
  POST_SUMMARIZATION_CONTINUATION_PROMPT,
} from "../post-summarization-continuation";

describe("post-summarization continuation", () => {
  it("injects an action-oriented continuation reminder", () => {
    expect(POST_SUMMARIZATION_CONTINUATION_PROMPT).toContain(
      "Continue the interrupted task now",
    );
    expect(POST_SUMMARIZATION_CONTINUATION_PROMPT).toContain(
      "Do not reply with an acknowledgement",
    );
    expect(POST_SUMMARIZATION_CONTINUATION_PROMPT).toContain(
      "call the next required tool",
    );
  });

  it("detects short English promise-only filler", () => {
    expect(isPostSummarizationFillerText("I'll continue now:")).toBe(true);
    expect(isPostSummarizationFillerText("Let me get to it.")).toBe(true);
  });

  it("detects short Persian promise-only filler from the incident pattern", () => {
    expect(isPostSummarizationFillerText("**عذر میخوام!** میرم سراغش:")).toBe(
      true,
    );
  });

  it("does not treat meaningful output as filler", () => {
    expect(
      isPostSummarizationFillerText(
        "I updated both files, ran the syntax checks, and here is the usage guide.",
      ),
    ).toBe(false);
  });

  it("does not flag long responses that merely mention continuing", () => {
    const text = `${"The task is complete. ".repeat(30)} I will include the details below.`;

    expect(isPostSummarizationFillerText(text)).toBe(false);
  });

  it("requires a normal stop with no post-compaction tool call", () => {
    expect(
      isIncompletePostSummarizationStop({
        finishReason: "stop",
        text: "I'm going to continue:",
        toolCallCount: 0,
      }),
    ).toBe(true);
    expect(
      isIncompletePostSummarizationStop({
        finishReason: "stop",
        text: "I'm going to continue:",
        toolCallCount: 1,
      }),
    ).toBe(false);
    expect(
      isIncompletePostSummarizationStop({
        finishReason: "length",
        text: "I'm going to continue:",
        toolCallCount: 0,
      }),
    ).toBe(false);
  });
});
