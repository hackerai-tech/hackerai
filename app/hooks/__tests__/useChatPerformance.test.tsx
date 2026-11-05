import { act, renderHook } from "@testing-library/react";
import { useChatPerformance } from "../useChatPerformance";
import { ChatPerformanceTracker } from "@/lib/analytics/chat-performance";
import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "@/lib/analytics/client";
import type { ChatMessage } from "@/types";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
  subscribeAuthenticatedAnalytics: jest.fn(() => () => {}),
}));

describe("rendered response measurement", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    global.CSS = { ...global.CSS, escape: (value) => value };
    document.body.innerHTML =
      '<div data-performance-message-id="assistant" data-performance-text-length="2"></div>';
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it.each([true, false])(
    "records visible text only after its paint opportunity (visible=%s)",
    async (visible) => {
      const node = document.querySelector("[data-performance-message-id]")!;
      jest.spyOn(node, "getBoundingClientRect").mockReturnValue({
        width: 100,
        height: 30,
        top: visible ? 10 : 3000,
        bottom: visible ? 40 : 3030,
        left: 0,
        right: 100,
      } as DOMRect);
      const tracker = new ChatPerformanceTracker();
      const messages = [
        {
          id: "assistant",
          role: "assistant",
          parts: [{ type: "text", text: "OK" }],
        },
      ] as ChatMessage[];
      const hook = renderHook(
        ({ status }) =>
          useChatPerformance({ tracker, chatId: "chat", messages, status }),
        { initialProps: { status: "submitted" } },
      );
      act(() => {
        tracker.start("chat", "ask", []);
      });
      hook.rerender({ status: "ready" });
      expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(50);
      });
      expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
        "chat_visible_response_performance",
        expect.objectContaining({
          visible_text_observed: visible,
          first_visible_text_ms: visible ? expect.any(Number) : null,
        }),
      );
      hook.unmount();
      expect(captureAuthenticatedEvent).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores reasoning-only output and excludes preexisting assistant messages", async () => {
    const tracker = new ChatPerformanceTracker();
    const hook = renderHook(
      ({ status }) =>
        useChatPerformance({
          tracker,
          chatId: "chat",
          messages: [
            {
              id: "assistant",
              role: "assistant",
              parts: [{ type: "reasoning", text: "private" }],
            },
          ] as ChatMessage[],
          status,
        }),
      { initialProps: { status: "submitted" } },
    );
    tracker.start("chat", "agent", ["assistant"]);
    hook.rerender({ status: "ready" });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "chat_visible_response_performance",
      expect.objectContaining({
        first_visible_text_ms: null,
        visible_text_observed: false,
      }),
    );
  });
});
