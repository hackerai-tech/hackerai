import { serialize, deserialize } from "node:v8";
import { ReadableStream } from "node:stream/web";
import { recoverCrashedAgentRun } from "../agent-crash-recovery";

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
      ...text("first", "ok"),
      ...text("second", "x".repeat(8 * 1024 * 1024)),
    ]),
  );
  await expect(recoverCrashedAgentRun(input)).rejects.toThrow();
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
