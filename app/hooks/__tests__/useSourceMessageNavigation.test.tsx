import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSourceMessageNavigation } from "../useSourceMessageNavigation";
import { getChatMessageElementId } from "@/lib/findings/source-message";

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
    document.body.appendChild(target);

    const { result } = renderHook(() =>
      useSourceMessageNavigation({
        messageIds: ["message-1"],
        paginationStatus: "Exhausted",
      }),
    );

    await waitFor(() => {
      expect(result.current).toBe("message-1");
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      });
      expect(target).toHaveFocus();
    });
  });

  it("loads older pages until the source message can be rendered", async () => {
    window.history.replaceState(null, "", "/c/chat-1#message=message-older");
    const loadMore = jest.fn();
    let messageIds = ["message-newer"];
    let paginationStatus: "CanLoadMore" | "LoadingMore" | "Exhausted" =
      "CanLoadMore";

    const { rerender } = renderHook(() =>
      useSourceMessageNavigation({
        messageIds,
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

    const target = document.createElement("div");
    target.id = getChatMessageElementId("message-older");
    target.tabIndex = -1;
    target.scrollIntoView = jest.fn();
    document.body.appendChild(target);
    messageIds = ["message-older", "message-newer"];
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
        messageIds: ["message-2"],
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
