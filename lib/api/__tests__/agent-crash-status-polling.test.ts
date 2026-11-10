import { NextRequest } from "next/server";
import { createAgentStatusPost } from "../agent-status-route";
import { fetchAgentLongStream } from "@/lib/chat/agent-long-transport";

const mockSaveMessage = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockCloseApproval = jest.fn();
const mockRetainedRead = jest.fn();
const mockBrowserRead = jest.fn();

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
  runs: {
    retrieve: async () => ({
      status: "CRASHED",
      metadata: { chatId: "chat", userId: "owner" },
    }),
  },
  streams: { read: (...args: unknown[]) => mockRetainedRead(...args) },
}));
jest.mock("@/lib/chat/trigger-browser-realtime", () => ({
  ...jest.requireActual("@/lib/chat/trigger-browser-realtime"),
  readTriggerRunStream: (...args: unknown[]) => mockBrowserRead(...args),
}));

it("closes the real streaming client after an oversized crash replay instead of polling it again", async () => {
  jest.useFakeTimers({
    doNotFake: ["queueMicrotask", "nextTick", "setImmediate"],
  });
  const originalFetch = global.fetch;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"agent_crash_recovery_blocked"'),
    );
  } finally {
    global.fetch = originalFetch;
    warn.mockRestore();
    jest.useRealTimers();
  }
});
