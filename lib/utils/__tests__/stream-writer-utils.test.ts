/**
 * Tests for step summarization writer helpers in stream-writer-utils.
 *
 * Covers:
 * - writeStepSummarizationStarted
 * - writeStepSummarizationCompleted
 */

import {
  writeStepSummarizationStarted,
  writeStepSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";

describe("writeStepSummarizationStarted", () => {
  it("writes a data-summarization message with status started", () => {
    const mockWriter = { write: jest.fn() };

    writeStepSummarizationStarted(mockWriter as any);

    expect(mockWriter.write).toHaveBeenCalledTimes(1);
    expect(mockWriter.write).toHaveBeenCalledWith({
      type: "data-summarization",
      id: "summarization-status",
      data: { status: "started", message: "Compressing tool steps" },
      transient: true,
    });
  });
});

describe("writeStepSummarizationCompleted", () => {
  it("writes a data-summarization message with status completed", () => {
    const mockWriter = { write: jest.fn() };

    writeStepSummarizationCompleted(mockWriter as any);

    expect(mockWriter.write).toHaveBeenCalledTimes(1);
    expect(mockWriter.write).toHaveBeenCalledWith({
      type: "data-summarization",
      id: "summarization-status",
      data: { status: "completed", message: "Tool steps compressed" },
      transient: true,
    });
  });
});
