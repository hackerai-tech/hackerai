import { renderHook } from "@testing-library/react";
import { useSavedChatFiles } from "../useSavedChatFiles";
import { collectChatFiles } from "@/lib/workspace-preview/chat-files";

type Page = {
  results: unknown[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: jest.Mock;
};
const mockPaginated = jest.fn();
let mockAuth = { isLoading: false, isAuthenticated: true };
let mockPage: Page;
jest.mock("convex/react", () => ({
  useConvexAuth: () => mockAuth,
  usePaginatedQuery: (...args: unknown[]) => {
    mockPaginated(...args);
    return args[1] === "skip"
      ? { results: [], status: "LoadingFirstPage", loadMore: jest.fn() }
      : mockPage;
  },
}));

const older = {
  id: "older",
  role: "assistant",
  fileDetails: [{ fileId: "pdf", name: "report.pdf" }],
};
const loaded = [
  {
    id: "latest",
    role: "assistant",
    parts: [{ type: "text", text: "Done" }],
  },
];
const page = (status: Page["status"], results: unknown[] = []) => {
  mockPage = { results, status, loadMore: jest.fn() };
  return mockPage;
};

beforeEach(() => {
  mockPaginated.mockClear();
  mockAuth = { isLoading: false, isAuthenticated: true };
  page("LoadingFirstPage");
});

it("does not query until Files is opened and auth is ready", () => {
  mockAuth = { isLoading: true, isAuthenticated: false };
  const { result, rerender } = renderHook(
    ({ enabled }) =>
      useSavedChatFiles({ chatId: "chat", messages: loaded, enabled }),
    { initialProps: { enabled: true } },
  );
  expect(mockPaginated).toHaveBeenLastCalledWith(expect.anything(), "skip", {
    initialNumItems: 14,
  });
  mockAuth = { isLoading: false, isAuthenticated: true };
  rerender({ enabled: false });
  expect(mockPaginated.mock.lastCall?.[1]).toBe("skip");
  expect(result.current).toEqual({ messages: loaded, loading: false });
  rerender({ enabled: true });
  expect(mockPaginated.mock.lastCall?.[1]).toEqual({ chatId: "chat" });
  expect(result.current.loading).toBe(true);
});

it("loads sequential pages, including empty ones, until the cursor is exhausted", () => {
  const { rerender, result } = renderHook(() =>
    useSavedChatFiles({ chatId: "chat", messages: loaded, enabled: true }),
  );
  const first = page("CanLoadMore", []);
  rerender();
  expect(first.loadMore).toHaveBeenCalledWith(14);
  const loading = page("LoadingMore", []);
  rerender();
  expect(loading.loadMore).not.toHaveBeenCalled();
  // Another empty page that is not the last page must keep loading.
  const empty = page("CanLoadMore", []);
  rerender();
  expect(empty.loadMore).toHaveBeenCalledTimes(1);
  const done = page("Exhausted", [older]);
  rerender();
  expect(done.loadMore).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
  expect(collectChatFiles(result.current.messages)).toEqual([
    expect.objectContaining({
      name: "report.pdf",
      saved: expect.objectContaining({ fileId: "pdf" }),
    }),
  ]);
  expect(result.current.messages.at(-1)).toBe(loaded[0]);
});

it("drops the previous chat's saved files when the chat or sign-in changes", () => {
  page("Exhausted", [older]);
  const { result, rerender } = renderHook(
    ({ chatId }) =>
      useSavedChatFiles({ chatId, messages: loaded, enabled: true }),
    { initialProps: { chatId: "chat-a" } },
  );
  expect(collectChatFiles(result.current.messages)).toHaveLength(1);
  page("LoadingFirstPage", []);
  rerender({ chatId: "chat-b" });
  expect(mockPaginated.mock.lastCall?.[1]).toEqual({ chatId: "chat-b" });
  expect(collectChatFiles(result.current.messages)).toEqual([]);
  page("Exhausted", [older]);
  mockAuth = { isLoading: false, isAuthenticated: false };
  rerender({ chatId: "chat-b" });
  expect(mockPaginated.mock.lastCall?.[1]).toBe("skip");
  expect(result.current.messages).toBe(loaded);
});
