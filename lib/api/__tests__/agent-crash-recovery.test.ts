import { serialize, deserialize } from "node:v8";
import { ReadableStream } from "node:stream/web";
import { UIMessageStreamError } from "ai";
import { recoverCrashedAgentRun } from "../agent-crash-recovery";
import { AgentCrashRecoveryReplayLimitError } from "../agent-crash-recovery-error";

const mockHistoryAccess = jest.fn();
jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: (...args: unknown[]) =>
    mockHistoryAccess(...args),
}));
const mockRead = jest.fn();
const mockSave = jest.fn();
jest.mock("@trigger.dev/sdk", () => ({
  streams: { read: (...args: unknown[]) => mockRead(...args) },
}));
jest.mock("@/lib/db/actions", () => ({
  saveMessage: (...args: unknown[]) => mockSave(...args),
}));

globalThis.structuredClone = (value) => deserialize(serialize(value));

const input = {
  chatId: "chat",
  userId: "owner",
  runId: "run",
  metadata: { chatId: "chat", userId: "owner" },
};
const stream = (chunks: unknown[]) =>
  new ReadableStream({
    start(c) {
      chunks.forEach((x) => c.enqueue(x));
      c.close();
    },
  });
const text = (id: string, value: string) => [
  { type: "start", messageId: id },
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: value },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockResolvedValue(null);
});

it("recovers separate assistant IDs, completed tool results and interrupted progress without executing tools", async () => {
  mockRead.mockResolvedValue(
    stream([
      ...text("first", "Saved answer"),
      { type: "text-end", id: "text" },
      { type: "finish" },
      { type: "start", messageId: "second" },
      {
        type: "tool-input-available",
        toolCallId: "done",
        toolName: "terminal",
        input: { command: "fixture" },
      },
      {
        type: "tool-output-available",
        toolCallId: "done",
        output: "completed fixture",
      },
      {
        type: "tool-input-available",
        toolCallId: "unknown",
        toolName: "terminal",
        input: { command: "fixture2" },
      },
      { type: "data-agent-heartbeat", data: { timestamp: 1 } },
    ]),
  );
  expect(await recoverCrashedAgentRun(input)).toBe("recovered");
  expect(mockSave).toHaveBeenCalledTimes(2);
  expect(mockSave.mock.calls[0][0]).toMatchObject({
    message: { id: "first", parts: [{ type: "text", text: "Saved answer" }] },
    expectedActiveTriggerRunId: "run",
  });
  const second = mockSave.mock.calls[1][0];
  expect(second.message.parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toolCallId: "done",
        state: "output-available",
        output: "completed fixture",
      }),
      expect.objectContaining({
        toolCallId: "unknown",
        state: "input-available",
      }),
    ]),
  );
  expect(
    second.message.parts.some((p: any) => p.type === "data-agent-heartbeat"),
  ).toBe(false);
});

it("rejects wrong-owner metadata before reading or writing", async () => {
  await expect(
    recoverCrashedAgentRun({
      ...input,
      metadata: { chatId: "other", userId: "owner" },
    }),
  ).rejects.toThrow();
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

it("does not persist a prefix when the retained stream fails", async () => {
  mockRead.mockResolvedValue(
    new ReadableStream({
      start(c) {
        text("first", "prefix").forEach((x) => c.enqueue(x));
        c.error(new Error("fixture read failure"));
      },
    }),
  );
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow();
  expect(mockSave).not.toHaveBeenCalled();
});

it("does not save a partial replay when its request-wide byte budget is exceeded", async () => {
  mockRead.mockResolvedValue(
    stream([
      ...text("first", "x".repeat(4 * 1024 * 1024)),
      ...text("second", "x".repeat(4 * 1024 * 1024)),
    ]),
  );
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
    AgentCrashRecoveryReplayLimitError,
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it("stops persistence if a newer run acquired the chat", async () => {
  mockRead.mockResolvedValue(
    stream([...text("first", "one"), ...text("second", "two")]),
  );
  mockSave.mockResolvedValueOnce("stale_run");
  expect(await recoverCrashedAgentRun(input)).toBe("stale");
  expect(mockSave).toHaveBeenCalledTimes(1);
});

it("propagates failed persistence so callers retain the run association", async () => {
  mockRead.mockResolvedValue(stream(text("first", "progress")));
  mockSave.mockRejectedValueOnce(new Error("fixture persistence failure"));
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
    "fixture persistence failure",
  );
});

it("does not read or persist progress when history access is blocked", async () => {
  mockHistoryAccess.mockRejectedValueOnce(new Error("fixture history blocked"));
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
    "fixture history blocked",
  );
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

it("drains control records and coalesced token deltas without retaining UI control events", async () => {
  mockRead.mockResolvedValue(
    stream([
      undefined,
      { type: "data-agent-run-correlation", data: { token: "fixture" } },
      { type: "start", messageId: "first" },
      { type: "text-start", id: "text" },
      ...Array.from({ length: 5000 }, () => ({
        type: "text-delta",
        id: "text",
        delta: "a",
      })),
    ]),
  );
  await recoverCrashedAgentRun(input);
  expect(mockSave.mock.calls[0][0].message.parts).toEqual([
    expect.objectContaining({ type: "text", text: "a".repeat(5000) }),
  ]);
});

it("rejects a truncated message prefix without writing any progress", async () => {
  mockRead.mockResolvedValue(
    stream([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "missing start" },
    ]),
  );
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
    "message boundary",
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it.each([
  { type: "text-delta", id: "private-part-id", delta: "private transcript" },
  {
    type: "tool-output-available",
    toolCallId: "private-tool-id",
    output: "private transcript",
  },
])(
  "diagnoses invalid $type ordering without leaking stream material",
  async (chunk) => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockRead.mockResolvedValue(
        stream([{ type: "start", messageId: "private-message-id" }, chunk]),
      );
      await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
        "Agent crash recovery message reconstruction failed",
      );
      expect(mockSave).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
      const diagnostic = JSON.parse(warning.mock.calls[0][0]);
      expect(diagnostic).toMatchObject({
        event: "agent_crash_reconstruction_failed",
        reason: "invalid_stream_state",
        chunk_type:
          chunk.type === "text-delta" ? "text-delta" : "tool-invocation",
        trigger_run_id: "run",
        record_count: 2,
        message_count: 1,
        coalesced_chunk_count: 2,
      });
      expect(diagnostic.replay_bytes).toBeGreaterThan(0);
      expect(JSON.stringify(diagnostic)).not.toContain("private");
    } finally {
      warning.mockRestore();
    }
  },
);

it("distinguishes the replay deadline during reconstruction without writing", async () => {
  let now = 0;
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  const clone = jest
    .spyOn(globalThis, "structuredClone")
    .mockImplementation((value) => {
      now = 15001;
      return deserialize(serialize(value));
    });
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mockRead.mockResolvedValue(stream(text("first", "private transcript")));
    await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
      "Agent crash recovery message reconstruction failed",
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
      reason: "deadline_exceeded",
      chunk_type: null,
      elapsed_ms: 15001,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
  } finally {
    clock.mockRestore();
    clone.mockRestore();
    warning.mockRestore();
  }
});

it("keeps unknown reducer errors private even when diagnostics fail", async () => {
  const clone = jest
    .spyOn(globalThis, "structuredClone")
    .mockImplementation(() => {
      throw new Error("private reducer failure");
    });
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {
    throw new Error("private logger failure");
  });
  try {
    mockRead.mockResolvedValue(stream(text("first", "private transcript")));
    await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
      "Agent crash recovery message reconstruction failed",
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
      reason: "unknown",
      chunk_type: null,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
  } finally {
    clone.mockRestore();
    warning.mockRestore();
  }
});

it("does not log an unrecognized SDK chunk category or its private error fields", async () => {
  const clone = jest
    .spyOn(globalThis, "structuredClone")
    .mockImplementation(() => {
      throw new UIMessageStreamError({
        chunkType: "private-category",
        chunkId: "private-part-id",
        message: "private reducer failure",
      });
    });
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mockRead.mockResolvedValue(stream(text("first", "private transcript")));
    await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
      "Agent crash recovery message reconstruction failed",
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
      reason: "invalid_stream_state",
      chunk_type: "other",
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
  } finally {
    clone.mockRestore();
    warning.mockRestore();
  }
});

it("does not treat the global deadline's clean abort as a successful replay", async () => {
  jest.useFakeTimers();
  try {
    mockRead.mockImplementation(
      async (_run, _key, options) =>
        new ReadableStream({
          start(c) {
            text("first", "prefix").forEach((x) => c.enqueue(x));
            options.signal.addEventListener("abort", () => c.close(), {
              once: true,
            });
          },
        }),
    );
    const pending = recoverCrashedAgentRun(input);
    const assertion = expect(pending).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(mockSave).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it("enforces the message budget across the whole replay", async () => {
  mockRead.mockResolvedValue(
    stream(
      Array.from({ length: 17 }, (_, n) =>
        text("message-" + n, "fixture"),
      ).flat(),
    ),
  );
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow(
    "message boundary",
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it("emits a bounded recovery receipt without transcript content", async () => {
  const log = jest.spyOn(console, "info").mockImplementation(() => {});
  try {
    mockRead.mockResolvedValue(
      stream(text("first", "private fixture content")),
    );
    await recoverCrashedAgentRun(input);
    expect(log).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(log.mock.calls[0][0]);
    expect(receipt).toMatchObject({
      event: "agent_crash_progress_recovered",
      trigger_run_id: "run",
      message_count: 1,
      record_count: 3,
    });
    expect(JSON.stringify(receipt)).not.toContain("private fixture content");
  } finally {
    log.mockRestore();
  }
});

it("propagates the request deadline into a pending save without a success receipt", async () => {
  jest.useFakeTimers();
  const log = jest.spyOn(console, "info").mockImplementation(() => {});
  try {
    mockRead.mockResolvedValue(stream(text("first", "progress")));
    mockSave.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const pending = recoverCrashedAgentRun(input);
    const rejected = expect(pending).rejects.toBeDefined();
    await jest.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    jest.useRealTimers();
  }
});

it("fails closed when the access preflight never settles", async () => {
  jest.useFakeTimers();
  try {
    mockHistoryAccess.mockImplementationOnce(() => new Promise(() => {}));
    const pending = recoverCrashedAgentRun(input);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
