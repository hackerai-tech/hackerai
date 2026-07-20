import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSourceMessageNavigation } from "../useSourceMessageNavigation";
import { getChatMessageElementId } from "@/lib/findings/source-message";
import { STICKY_BOTTOM_ESCAPE_EVENT } from "@/lib/utils/scroll-events";

describe("useSourceMessageNavigation", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  it("scrolls to and focuses the source message from the URL fragment", async () => {
    window.history.replaceState(null, "", "/c/chat-1#message=message-1");
    const target = document.createElement("div");
    target.id = getChatMessageElementId("message-1");
    target.tabIndex = -1;
    const scrollIntoView = jest.fn();
    target.scrollIntoView = scrollIntoView;
    const focus = jest.spyOn(target, "focus");
    document.body.appendChild(target);
    const escapeStickyBottom = jest.fn();
    window.addEventListener(STICKY_BOTTOM_ESCAPE_EVENT, escapeStickyBottom);

    const { result } = renderHook(() =>
      useSourceMessageNavigation({
        loadedMessageCount: 1,
        paginationStatus: "Exhausted",
      }),
    );

    await waitFor(() => {
      expect(result.current).toBe("message-1");
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
      expect(target).toHaveFocus();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(focus.mock.invocationCallOrder[0]).toBeLessThan(
        scrollIntoView.mock.invocationCallOrder[0],
      );
      expect(escapeStickyBottom).toHaveBeenCalledTimes(1);
    });

    window.removeEventListener(STICKY_BOTTOM_ESCAPE_EVENT, escapeStickyBottom);
  });

  it("keeps loading when a page adds only hidden messages", async () => {
    window.history.replaceState(null, "", "/c/chat-1#message=message-older");
    const loadMore = jest.fn();
    let loadedMessageCount = 1;
    let paginationStatus: "CanLoadMore" | "LoadingMore" | "Exhausted" =
      "CanLoadMore";

    const { rerender } = renderHook(() =>
      useSourceMessageNavigation({
        loadedMessageCount,
        paginationStatus,
        loadMore,
      }),
    );

    await waitFor(() => expect(loadMore).toHaveBeenCalledWith(28));
    rerender();
    expect(loadMore).toHaveBeenCalledTimes(1);

    paginationStatus = "LoadingMore";
    rerender();
    expect(loadMore).toHaveBeenCalledTimes(1);

    loadedMessageCount = 2;
    paginationStatus = "CanLoadMore";
    rerender();
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(2));

    const target = document.createElement("div");
    target.id = getChatMessageElementId("message-older");
    target.tabIndex = -1;
    target.scrollIntoView = jest.fn();
    document.body.appendChild(target);
    loadedMessageCount = 3;
    paginationStatus = "Exhausted";
    rerender();

    await waitFor(() => expect(target).toHaveFocus());
  });

  it("responds to a source-message hash change without a page reload", async () => {
    const target = document.createElement("div");
    target.id = getChatMessageElementId("message-2");
    target.tabIndex = -1;
    target.scrollIntoView = jest.fn();
    document.body.appendChild(target);

    const { result } = renderHook(() =>
      useSourceMessageNavigation({
        loadedMessageCount: 1,
        paginationStatus: "Exhausted",
      }),
    );
    expect(result.current).toBeNull();

    act(() => {
      window.history.replaceState(null, "", "/c/chat-1#message=message-2");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(result.current).toBe("message-2");
      expect(target).toHaveFocus();
    });
  });
});
