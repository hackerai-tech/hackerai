import { NextRequest } from "next/server";
import { createAgentStatusPost } from "../agent-status-route";
import { fetchAgentLongStream } from "@/lib/chat/agent-long-transport";

const mockSaveMessage = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockCloseApproval = jest.fn();
const mockRetainedRead = jest.fn();
const mockBrowserRead = jest.fn();
const mockRunsRetrieve = jest.fn();

jest.mock("next/server", () => {
  // Supply Web HTTP primitives missing from jsdom, retaining the real route
  // responses and the real browser transport/status decoder below.
  const web = jest.requireActual(
    "next/dist/compiled/@edge-runtime/primitives/fetch",
  );
  globalThis.Request = web.Request;
  globalThis.Response = web.Response;
  globalThis.Headers = web.Headers;
  return jest.requireActual("next/server");
});

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: async () => ({ userId: "owner" }),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: async () => undefined,
}));
jest.mock("@/lib/db/actions", () => ({
  getChatById: async () => ({
    id: "chat",
    user_id: "owner",
    active_trigger_run_id: "run",
  }),
  saveMessage: (...args: unknown[]) => mockSaveMessage(...args),
  setActiveTriggerRun: (...args: unknown[]) => mockSetActiveTriggerRun(...args),
}));
jest.mock("@/lib/api/agent-approval-session", () => ({
  closeAgentApprovalSession: (...args: unknown[]) => mockCloseApproval(...args),
}));
jest.mock("@trigger.dev/sdk", () => ({
  ApiError: class extends Error {},
  runs: { retrieve: (...args: unknown[]) => mockRunsRetrieve(...args) },
  streams: { read: (...args: unknown[]) => mockRetainedRead(...args) },
}));
jest.mock("@/lib/chat/trigger-browser-realtime", () => ({
  ...jest.requireActual("@/lib/chat/trigger-browser-realtime"),
  readTriggerRunStream: (...args: unknown[]) => mockBrowserRead(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

it("closes the real streaming client after an oversized crash replay instead of polling it again", async () => {
  jest.useFakeTimers({
    doNotFake: ["queueMicrotask", "nextTick", "setImmediate"],
  });
  const originalFetch = global.fetch;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat", userId: "owner" },
    });
    mockRetainedRead.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          for (const messageId of ["first", "second"]) {
            controller.enqueue({ type: "start", messageId });
            controller.enqueue({ type: "text-start", id: messageId });
            controller.enqueue({
              type: "text-delta",
              id: messageId,
              delta: "x".repeat(4 * 1024 * 1024),
            });
          }
          controller.close();
        },
      }),
    );
    mockBrowserRead.mockImplementation((_run, _stream, { signal }) =>
      (async function* () {
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      })(),
    );
    const statusRoute = createAgentStatusPost({ endpoint: "/api/agent" });
    let statusPolls = 0;
    global.fetch = jest.fn(async (url, init) => {
      if (url === "/api/agent")
        return Response.json({ runId: "run", publicAccessToken: "synthetic" });
      if (url === "/api/agent/status") {
        statusPolls++;
        return statusRoute(
          new NextRequest("https://fixture.invalid/api/agent/status", {
            ...init,
            method: "POST",
          }),
        );
      }
      throw new Error("Unexpected fixture request");
    }) as typeof fetch;
    const onRunClosed = jest.fn();
    const response = await fetchAgentLongStream(
      { method: "POST", body: JSON.stringify({ chatId: "chat" }) },
      undefined,
      onRunClosed,
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      body += decoder.decode(result.value);
    }
    expect(body).toContain('"type":"abort"');
    expect(statusPolls).toBe(1);
    expect(onRunClosed).toHaveBeenCalledTimes(1);
    expect(onRunClosed).toHaveBeenCalledWith("run");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(statusPolls).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseApproval).not.toHaveBeenCalled();
    const blocked = warn.mock.calls
      .map(([line]) => JSON.parse(line))
      .filter((line) => line.event === "agent_crash_recovery_blocked");
    // The second message's large delta crosses the cap; nothing was discarded.
    const deltaBytes = Buffer.byteLength(
      JSON.stringify({
        type: "text-delta",
        id: "second",
        delta: "x".repeat(4 * 1024 * 1024),
      }),
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      action: "status",
      reason: "replay_byte_limit",
      replay_limit_diagnostic_version: 1,
      replay_discarded_prefix_bytes: 0,
      replay_prefix_record_count: 5,
      replay_crossing_record_bytes: deltaBytes,
    });
    expect(blocked[0].replay_prefix_bytes).toBeGreaterThan(deltaBytes);
    expect(blocked[0].replay_prefix_bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  } finally {
    global.fetch = originalFetch;
    warn.mockRestore();
    jest.useRealTimers();
  }
});

it("keeps the real streaming client on its run through a hanging status read and finishes the original reply", async () => {
  jest.useFakeTimers({
    doNotFake: ["queueMicrotask", "nextTick", "setImmediate"],
  });
  const originalFetch = global.fetch;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const unhandled = jest.fn();
  process.on("unhandledRejection", unhandled);
  try {
    // The first lookup is held until aborted, like a real stalled fetch; the
    // next poll's lookup answers.
    const lookupSignals: AbortSignal[] = [];
    mockRunsRetrieve
      .mockImplementationOnce(
        (_runId: string, { signal }: { signal: AbortSignal }) => {
          lookupSignals.push(signal);
          return new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("synthetic aborted lookup")),
              { once: true },
            ),
          );
        },
      )
      .mockImplementationOnce(
        async (_runId: string, { signal }: { signal: AbortSignal }) => {
          lookupSignals.push(signal);
          return {
            status: "EXECUTING",
            metadata: { chatId: "chat", userId: "owner" },
          };
        },
      );
    let releaseReply!: () => void;
    const replyReady = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    mockBrowserRead.mockImplementation((_run, _stream, { signal }) =>
      (async function* () {
        await replyReady;
        if (signal.aborted) return;
        yield { type: "start", messageId: "reply" };
        yield { type: "text-start", id: "reply" };
        yield {
          type: "text-delta",
          id: "reply",
          delta: "Synthetic reply after status recovery",
        };
        yield { type: "text-end", id: "reply" };
        yield { type: "finish" };
      })(),
    );
    const statusRoute = createAgentStatusPost({ endpoint: "/api/agent" });
    const statusRequests: unknown[] = [];
    const statusResponses: { status: number; body: unknown }[] = [];
    global.fetch = jest.fn(async (url, init) => {
      if (url === "/api/agent")
        return Response.json({ runId: "run", publicAccessToken: "synthetic" });
      if (url === "/api/agent/status") {
        statusRequests.push(JSON.parse(String(init?.body)));
        const response = await statusRoute(
          new NextRequest("https://fixture.invalid/api/agent/status", {
            ...init,
            method: "POST",
          }),
        );
        statusResponses.push({
          status: response.status,
          body: await response.clone().json(),
        });
        return response;
      }
      throw new Error("Unexpected fixture request");
    }) as typeof fetch;
    const onRunClosed = jest.fn();
    const response = await fetchAgentLongStream(
      { method: "POST", body: JSON.stringify({ chatId: "chat" }) },
      undefined,
      onRunClosed,
    );

    await jest.advanceTimersByTimeAsync(4_999);
    expect(statusRequests).toHaveLength(1);
    expect(statusResponses).toEqual([]);
    expect(lookupSignals[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(statusResponses).toEqual([
      { status: 503, body: expect.objectContaining({ code: "offline:api" }) },
    ]);
    // The expired lookup itself is stopped, not just abandoned.
    expect(lookupSignals[0].aborted).toBe(true);
    // A nonterminal 503 leaves the client attached to the same run; its next
    // scheduled poll sees the run is still executing.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(statusResponses).toEqual([
      expect.objectContaining({ status: 503 }),
      { status: 200, body: { status: "EXECUTING", terminal: false } },
    ]);
    // That poll's lookup has its own signal, untouched by the earlier abort.
    expect(lookupSignals).toHaveLength(2);
    expect(lookupSignals[1]).not.toBe(lookupSignals[0]);
    expect(lookupSignals[1].aborted).toBe(false);
    expect(statusRequests).toEqual([
      { chatId: "chat", runId: "run" },
      { chatId: "chat", runId: "run" },
    ]);
    expect(onRunClosed).not.toHaveBeenCalled();

    releaseReply();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      body += decoder.decode(result.value);
    }
    expect(body).toContain("Synthetic reply after status recovery");
    expect(body).toContain('"type":"finish"');
    expect(body).not.toContain('"type":"abort"');
    expect(onRunClosed).toHaveBeenCalledTimes(1);
    expect(onRunClosed).toHaveBeenCalledWith("run");
    // One subscription to the original run's stream; no reattach or new run.
    expect(mockBrowserRead).toHaveBeenCalledTimes(1);
    expect(mockBrowserRead.mock.calls[0][0]).toBe("run");
    expect(mockRunsRetrieve.mock.calls).toEqual([
      ["run", expect.objectContaining({ retry: { maxAttempts: 1 } })],
      ["run", expect.objectContaining({ retry: { maxAttempts: 1 } })],
    ]);

    // The aborted lookup's own rejection was handled and changed nothing.
    await new Promise((resolve) =>
      jest
        .requireActual<typeof import("node:timers")>("node:timers")
        .setImmediate(resolve),
    );
    expect(unhandled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(statusRequests).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseApproval).not.toHaveBeenCalled();

    const logs = warn.mock.calls.map(([line]) => JSON.parse(line));
    expect(
      logs.filter(
        (line) => line.event === "agent_status_trigger_read_deadline",
      ),
    ).toEqual([
      expect.objectContaining({
        endpoint: "/api/agent",
        chat_id: "chat",
        trigger_run_id: "run",
        stage: "retrieve_trigger_run",
        trigger_run_read_api_body: "not_observed",
        trigger_run_read_deadline_ms: 5_000,
      }),
    ]);
    expect(
      logs.filter((line) => line.event === "agent_route_service_unavailable"),
    ).toEqual([
      expect.objectContaining({
        action: "status",
        stage: "retrieve_trigger_run",
        error_code: "offline:api",
        http_status: 503,
      }),
    ]);
  } finally {
    process.off("unhandledRejection", unhandled);
    global.fetch = originalFetch;
    warn.mockRestore();
    jest.useRealTimers();
  }
});
