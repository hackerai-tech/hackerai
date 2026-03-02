import { describe, it, expect, jest } from "@jest/globals";

jest.doMock("server-only", () => ({}));

const {
  writeSummarizationStarted,
  writeSummarizationCompleted,
  createSummarizationCompletedPart,
  writeSummarizationEnriched,
  injectSummarizationParts,
} =
  require("../stream-writer-utils") as typeof import("../stream-writer-utils");

type MockWriter = { write: jest.Mock };

const createMockWriter = (): MockWriter => ({ write: jest.fn() });

describe("writeSummarizationStarted", () => {
  it.each([
    {
      name: "uses default ID when no summarizationId is provided",
      summarizationId: undefined,
      expectedId: "summarization-status",
    },
    {
      name: "uses suffixed ID when summarizationId=0",
      summarizationId: 0,
      expectedId: "summarization-status-0",
    },
    {
      name: "uses suffixed ID when summarizationId=3",
      summarizationId: 3,
      expectedId: "summarization-status-3",
    },
    {
      name: "uses suffixed ID when summarizationId=42",
      summarizationId: 42,
      expectedId: "summarization-status-42",
    },
  ])("$name", ({ summarizationId, expectedId }) => {
    const writer = createMockWriter();

    writeSummarizationStarted(writer as any, summarizationId);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith({
      type: "data-summarization",
      id: expectedId,
      data: {
        status: "started",
        message: "Summarizing chat context",
      },
      transient: true,
    });
  });
});

describe("writeSummarizationCompleted", () => {
  it.each([
    {
      name: "uses default ID when no summarizationId is provided",
      summarizationId: undefined,
      expectedId: "summarization-status",
    },
    {
      name: "uses suffixed ID when summarizationId=0",
      summarizationId: 0,
      expectedId: "summarization-status-0",
    },
    {
      name: "uses suffixed ID when summarizationId=3",
      summarizationId: 3,
      expectedId: "summarization-status-3",
    },
  ])("$name", ({ summarizationId, expectedId }) => {
    const writer = createMockWriter();

    writeSummarizationCompleted(writer as any, summarizationId);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith({
      type: "data-summarization",
      id: expectedId,
      data: {
        status: "completed",
        message: "Chat context summarized",
      },
    });
  });

  it("does not include transient flag on completed events", () => {
    const writer = createMockWriter();

    writeSummarizationCompleted(writer as any);

    const call = writer.write.mock.calls[0][0];
    expect(call).not.toHaveProperty("transient");
  });
});

describe("createSummarizationCompletedPart", () => {
  it.each([
    {
      name: "uses default ID when no opts provided",
      opts: undefined,
      expectedId: "summarization-status",
    },
    {
      name: "uses default ID when opts has no summarizationId",
      opts: { messageSummary: "summary text" },
      expectedId: "summarization-status",
    },
    {
      name: "uses suffixed ID when summarizationId=0",
      opts: { summarizationId: 0 },
      expectedId: "summarization-status-0",
    },
    {
      name: "uses suffixed ID when summarizationId=3",
      opts: { summarizationId: 3 },
      expectedId: "summarization-status-3",
    },
  ])("$name", ({ opts, expectedId }) => {
    const part = createSummarizationCompletedPart(opts);

    expect(part.type).toBe("data-summarization");
    expect((part as { id: string }).id).toBe(expectedId);
    expect((part as { data: { status: string } }).data.status).toBe(
      "completed",
    );
  });

  it("includes messageSummary in data when provided", () => {
    const part = createSummarizationCompletedPart({
      messageSummary: "msg summary",
    });
    const data = (part as { data: Record<string, unknown> }).data;

    expect(data.messageSummary).toBe("msg summary");
    expect(data).not.toHaveProperty("stepSummary");
  });

  it("includes stepSummary in data when provided", () => {
    const part = createSummarizationCompletedPart({
      stepSummary: "step summary",
    });
    const data = (part as { data: Record<string, unknown> }).data;

    expect(data.stepSummary).toBe("step summary");
    expect(data).not.toHaveProperty("messageSummary");
  });

  it("includes both messageSummary and stepSummary when provided", () => {
    const part = createSummarizationCompletedPart({
      messageSummary: "msg",
      stepSummary: "step",
      summarizationId: 1,
    });
    const data = (part as { data: Record<string, unknown> }).data;

    expect(data.messageSummary).toBe("msg");
    expect(data.stepSummary).toBe("step");
    expect((part as { id: string }).id).toBe("summarization-status-1");
  });

  it("omits messageSummary and stepSummary from data when not provided", () => {
    const part = createSummarizationCompletedPart();
    const data = (part as { data: Record<string, unknown> }).data;

    expect(data).not.toHaveProperty("messageSummary");
    expect(data).not.toHaveProperty("stepSummary");
    expect(data.status).toBe("completed");
    expect(data.message).toBe("Chat context summarized");
  });
});

describe("writeSummarizationEnriched", () => {
  it.each([
    {
      name: "uses default ID when no summarizationId",
      opts: { messageSummary: "msg" },
      expectedId: "summarization-status",
    },
    {
      name: "uses suffixed ID when summarizationId=0",
      opts: { summarizationId: 0, messageSummary: "msg" },
      expectedId: "summarization-status-0",
    },
    {
      name: "uses suffixed ID when summarizationId=5",
      opts: { summarizationId: 5, stepSummary: "step" },
      expectedId: "summarization-status-5",
    },
  ])("$name", ({ opts, expectedId }) => {
    const writer = createMockWriter();

    writeSummarizationEnriched(writer as any, opts);

    expect(writer.write).toHaveBeenCalledTimes(1);
    const call = writer.write.mock.calls[0][0];
    expect(call.type).toBe("data-summarization");
    expect(call.id).toBe(expectedId);
    expect(call.data.status).toBe("completed");
  });

  it("includes messageSummary in written data", () => {
    const writer = createMockWriter();

    writeSummarizationEnriched(writer as any, {
      messageSummary: "the message summary",
    });

    const data = writer.write.mock.calls[0][0].data;
    expect(data.messageSummary).toBe("the message summary");
  });

  it("includes stepSummary in written data", () => {
    const writer = createMockWriter();

    writeSummarizationEnriched(writer as any, {
      stepSummary: "the step summary",
    });

    const data = writer.write.mock.calls[0][0].data;
    expect(data.stepSummary).toBe("the step summary");
  });

  it("includes both messageSummary and stepSummary when provided", () => {
    const writer = createMockWriter();

    writeSummarizationEnriched(writer as any, {
      summarizationId: 2,
      messageSummary: "msg",
      stepSummary: "step",
    });

    const call = writer.write.mock.calls[0][0];
    expect(call.id).toBe("summarization-status-2");
    expect(call.data.messageSummary).toBe("msg");
    expect(call.data.stepSummary).toBe("step");
    expect(call.data.status).toBe("completed");
    expect(call.data.message).toBe("Chat context summarized");
  });

  it("omits messageSummary from data when not provided", () => {
    const writer = createMockWriter();

    writeSummarizationEnriched(writer as any, { stepSummary: "step" });

    const data = writer.write.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("messageSummary");
  });

  it("omits stepSummary from data when not provided", () => {
    const writer = createMockWriter();

    writeSummarizationEnriched(writer as any, { messageSummary: "msg" });

    const data = writer.write.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("stepSummary");
  });
});

describe("injectSummarizationParts", () => {
  const stepStartPart = { type: "step-start" as const };
  const textPart = { type: "text" as const, text: "hello" };
  const toolPart = { type: "tool-invocation" as const };

  it("returns original parts when events array is empty", () => {
    const parts = [stepStartPart, textPart];
    const result = injectSummarizationParts(parts, []);

    expect(result).toBe(parts);
  });

  it("injects summarization part before the matching step-start", () => {
    const parts = [textPart, stepStartPart, toolPart];
    const events = [{ stepIndex: 0, messageSummary: "summary for step 0" }];

    const result = injectSummarizationParts(parts, events);

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(textPart);
    expect((result[1] as { type: string }).type).toBe("data-summarization");
    expect(
      (result[1] as { data: { messageSummary: string } }).data.messageSummary,
    ).toBe("summary for step 0");
    expect(result[2]).toBe(stepStartPart);
    expect(result[3]).toBe(toolPart);
  });

  it("injects at correct positions for multiple step-start parts", () => {
    const step0 = { type: "step-start" as const };
    const step1 = { type: "step-start" as const };
    const step2 = { type: "step-start" as const };
    const parts = [step0, textPart, step1, textPart, step2];
    const events = [{ stepIndex: 1, messageSummary: "summary at step 1" }];

    const result = injectSummarizationParts(parts, events);

    // Original 5 parts + 1 injected = 6
    expect(result).toHaveLength(6);
    // step0, text, summarization-part, step1, text, step2
    expect(result[0]).toBe(step0);
    expect(result[1]).toBe(textPart);
    expect((result[2] as { type: string }).type).toBe("data-summarization");
    expect(result[3]).toBe(step1);
    expect(result[4]).toBe(textPart);
    expect(result[5]).toBe(step2);
  });

  it("does not inject when no matching stepIndex in events", () => {
    const parts = [stepStartPart, textPart];
    const events = [{ stepIndex: 5, messageSummary: "out of range" }];

    const result = injectSummarizationParts(parts, events);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(stepStartPart);
    expect(result[1]).toBe(textPart);
  });

  it("passes messageSummary and stepSummary to the created part", () => {
    const parts = [stepStartPart];
    const events = [
      {
        stepIndex: 0,
        messageSummary: "msg summary",
        stepSummary: "step summary",
      },
    ];

    const result = injectSummarizationParts(parts, events);

    expect(result).toHaveLength(2);
    const injected = result[0] as { data: Record<string, unknown> };
    expect(injected.data.messageSummary).toBe("msg summary");
    expect(injected.data.stepSummary).toBe("step summary");
  });

  it("passes summarizationId through to createSummarizationCompletedPart", () => {
    const parts = [stepStartPart];
    const events = [
      {
        stepIndex: 0,
        summarizationId: 3,
        messageSummary: "msg",
      },
    ];

    const result = injectSummarizationParts(parts, events);

    expect(result).toHaveLength(2);
    const injected = result[0] as { id: string };
    expect(injected.id).toBe("summarization-status-3");
  });

  it("uses default ID when event has no summarizationId", () => {
    const parts = [stepStartPart];
    const events = [{ stepIndex: 0, messageSummary: "msg" }];

    const result = injectSummarizationParts(parts, events);

    const injected = result[0] as { id: string };
    expect(injected.id).toBe("summarization-status");
  });

  it("handles summarizationId=0 correctly (falsy but defined)", () => {
    const parts = [stepStartPart];
    const events = [
      {
        stepIndex: 0,
        summarizationId: 0,
        messageSummary: "msg",
      },
    ];

    const result = injectSummarizationParts(parts, events);

    const injected = result[0] as { id: string };
    expect(injected.id).toBe("summarization-status-0");
  });
});

describe("lastMessageSummary carry-forward pattern", () => {
  it("enriched event carries forward a previous message summary alongside step summary", () => {
    const writer = createMockWriter();
    const lastMessageSummary = "Previous message summary from combined path";

    // Simulate standalone step path: writeSummarizationEnriched called with
    // lastMessageSummary carried forward from a previous combined summarization
    writeSummarizationEnriched(writer as any, {
      summarizationId: 2,
      stepSummary: "New step summary",
      messageSummary: lastMessageSummary,
    });

    const call = writer.write.mock.calls[0][0];
    expect(call.id).toBe("summarization-status-2");
    expect(call.data.status).toBe("completed");
    expect(call.data.messageSummary).toBe(lastMessageSummary);
    expect(call.data.stepSummary).toBe("New step summary");
  });

  it("enriched event omits messageSummary when no previous summary exists", () => {
    const writer = createMockWriter();
    const lastMessageSummary: string | undefined = undefined;

    writeSummarizationEnriched(writer as any, {
      summarizationId: 1,
      stepSummary: "Step summary only",
      messageSummary: lastMessageSummary,
    });

    const data = writer.write.mock.calls[0][0].data;
    expect(data.stepSummary).toBe("Step summary only");
    expect(data).not.toHaveProperty("messageSummary");
  });

  it("injectSummarizationParts preserves carried-forward messageSummary at save time", () => {
    const stepStartPart = { type: "step-start" as const };
    const events = [
      {
        stepIndex: 0,
        stepSummary: "step text",
        messageSummary: "carried-forward msg",
        summarizationId: 2,
      },
    ];

    const result = injectSummarizationParts([stepStartPart], events);

    expect(result).toHaveLength(2);
    const injected = result[0] as { id: string; data: Record<string, unknown> };
    expect(injected.id).toBe("summarization-status-2");
    expect(injected.data.messageSummary).toBe("carried-forward msg");
    expect(injected.data.stepSummary).toBe("step text");
  });
});
