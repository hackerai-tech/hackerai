import { describe, expect, it } from "@jest/globals";
import { createToolInputDedupFilter } from "../trigger-chat-tool-input-dedup";

describe("createToolInputDedupFilter", () => {
  it("keeps tool-input-delta chunks before tool-input-available", () => {
    const filter = createToolInputDedupFilter();
    expect(
      filter.shouldDrop({ type: "tool-input-start", toolCallId: "t1" }),
    ).toBe(false);
    expect(
      filter.shouldDrop({ type: "tool-input-delta", toolCallId: "t1" }),
    ).toBe(false);
    expect(
      filter.shouldDrop({ type: "tool-input-delta", toolCallId: "t1" }),
    ).toBe(false);
  });

  it("drops empty tool-input-delta that arrives after tool-input-available", () => {
    const filter = createToolInputDedupFilter();
    filter.shouldDrop({ type: "tool-input-delta", toolCallId: "t1" });
    expect(
      filter.shouldDrop({ type: "tool-input-available", toolCallId: "t1" }),
    ).toBe(false);
    // The bug repro: a stray late tool-input-delta after the input is complete
    // would otherwise flip the part back to input-streaming in the AI SDK,
    // hiding the terminal command card in the UI.
    expect(
      filter.shouldDrop({ type: "tool-input-delta", toolCallId: "t1" }),
    ).toBe(true);
  });

  it("scopes the completion flag per toolCallId", () => {
    const filter = createToolInputDedupFilter();
    filter.shouldDrop({ type: "tool-input-available", toolCallId: "t1" });
    expect(
      filter.shouldDrop({ type: "tool-input-delta", toolCallId: "t2" }),
    ).toBe(false);
    expect(
      filter.shouldDrop({ type: "tool-input-delta", toolCallId: "t1" }),
    ).toBe(true);
  });

  it("never drops non tool-input-delta chunks for completed ids", () => {
    const filter = createToolInputDedupFilter();
    filter.shouldDrop({ type: "tool-input-available", toolCallId: "t1" });
    expect(
      filter.shouldDrop({ type: "tool-output-available", toolCallId: "t1" }),
    ).toBe(false);
    expect(filter.shouldDrop({ type: "data-terminal", toolCallId: "t1" })).toBe(
      false,
    );
    expect(filter.shouldDrop({ type: "finish-step" })).toBe(false);
  });

  it("ignores chunks with no toolCallId", () => {
    const filter = createToolInputDedupFilter();
    expect(filter.shouldDrop({ type: "tool-input-delta" })).toBe(false);
    expect(filter.shouldDrop({ type: "tool-input-available" })).toBe(false);
  });
});
