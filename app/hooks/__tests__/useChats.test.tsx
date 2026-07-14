import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { useChats } from "../useChats";

const convexReact = require("convex/react");

describe("useChats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    convexReact.resetMockConvexAuth?.();
    convexReact.resetMockConvexQueries?.();
  });

  it("keeps the sidebar history loading while Convex auth is loading", () => {
    convexReact.setMockConvexAuth?.({
      isLoading: true,
      isAuthenticated: false,
    });
    convexReact.setMockPaginatedQueryResult?.({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const { result } = renderHook(() => useChats());

    expect(result.current.results).toEqual([]);
    expect(result.current.status).toBe("LoadingFirstPage");
  });

  it("keeps the sidebar history loading when auth has not authenticated yet", () => {
    convexReact.setMockConvexAuth?.({
      isLoading: false,
      isAuthenticated: false,
    });
    convexReact.setMockPaginatedQueryResult?.({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const { result } = renderHook(() => useChats());

    expect(result.current.results).toEqual([]);
    expect(result.current.status).toBe("LoadingFirstPage");
  });

  it("preserves the chat query result once auth is ready", () => {
    const loadMore = jest.fn();
    convexReact.setMockPaginatedQueryResult?.({
      results: [{ id: "chat-1", title: "Loaded chat" }],
      status: "Exhausted",
      loadMore,
      isLoading: false,
    });

    const { result } = renderHook(() => useChats());

    expect(result.current.results).toEqual([
      { id: "chat-1", title: "Loaded chat" },
    ]);
    expect(result.current.status).toBe("Exhausted");
    expect(result.current.loadMore).toBe(loadMore);
  });

  it("does not force loading when fetching is intentionally skipped", () => {
    convexReact.setMockConvexAuth?.({
      isLoading: true,
      isAuthenticated: false,
    });
    convexReact.setMockPaginatedQueryResult?.({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    const { result } = renderHook(() => useChats(false));

    expect(result.current.status).toBe("Exhausted");
  });
});
