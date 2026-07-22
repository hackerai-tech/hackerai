import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useConvex } from "convex/react";
import { MessageSearchDialog } from "../MessageSearchDialog";

jest.mock("@/convex/_generated/api", () => ({
  api: {
    messages: { searchMessages: "messages.searchMessages" },
  },
}));

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    setChatSidebarOpen: jest.fn(),
    closeSidebar: jest.fn(),
  }),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/app/hooks/useChats", () => ({
  useChats: () => ({
    results: [],
    status: "Exhausted",
    loadMore: jest.fn(),
    isLoading: false,
  }),
}));

const originalIntersectionObserver = global.IntersectionObserver;

const makeSearchResult = (id: string, content: string) => ({
  id,
  chat_id: `chat-${id}`,
  content,
  created_at: Date.now(),
  match_type: "message" as const,
});

const runDebounce = async () => {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
};

describe("MessageSearchDialog", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (useConvex().query as jest.Mock).mockReset();
  });

  afterEach(() => {
    global.IntersectionObserver = originalIntersectionObserver;
    jest.useRealTimers();
  });

  it("uses one-shot search and clears it when the dialog closes", async () => {
    const query = useConvex().query as jest.Mock;
    query.mockResolvedValue({ page: [], isDone: true, continueCursor: "" });

    const { rerender } = render(
      <MessageSearchDialog isOpen={true} onClose={jest.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search messages..."), {
      target: { value: "billing" },
    });
    await runDebounce();

    await waitFor(() => {
      expect(query).toHaveBeenCalledTimes(1);
    });
    expect(query).toHaveBeenCalledWith("messages.searchMessages", {
      searchQuery: "billing",
      paginationOpts: { numItems: 20, cursor: null },
    });

    rerender(<MessageSearchDialog isOpen={false} onClose={jest.fn()} />);
    rerender(<MessageSearchDialog isOpen={true} onClose={jest.fn()} />);

    expect(screen.getByPlaceholderText("Search messages...")).toHaveValue("");
    await runDebounce();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("ignores stale results when the query changes", async () => {
    const query = useConvex().query as jest.Mock;
    let resolveFirstSearch!: (value: {
      page: ReturnType<typeof makeSearchResult>[];
      isDone: boolean;
      continueCursor: string;
    }) => void;
    const firstSearch = new Promise<{
      page: ReturnType<typeof makeSearchResult>[];
      isDone: boolean;
      continueCursor: string;
    }>((resolve) => {
      resolveFirstSearch = resolve;
    });

    query
      .mockImplementationOnce(() => firstSearch)
      .mockResolvedValueOnce({
        page: [makeSearchResult("new", "new result")],
        isDone: true,
        continueCursor: "",
      });

    render(<MessageSearchDialog isOpen={true} onClose={jest.fn()} />);
    const input = screen.getByPlaceholderText("Search messages...");

    fireEvent.change(input, { target: { value: "first" } });
    await runDebounce();
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "second" } });
    await runDebounce();
    await waitFor(() => expect(screen.getByText("new result")).toBeVisible());

    await act(async () => {
      resolveFirstSearch({
        page: [makeSearchResult("stale", "stale result")],
        isDone: true,
        continueCursor: "",
      });
    });

    expect(screen.queryByText("stale result")).not.toBeInTheDocument();
    expect(screen.getByText("new result")).toBeVisible();
  });

  it("shows a search error instead of an empty-results state", async () => {
    const query = useConvex().query as jest.Mock;
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error("search unavailable"));

    render(<MessageSearchDialog isOpen={true} onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search messages..."), {
      target: { value: "billing" },
    });
    await runDebounce();

    await waitFor(() =>
      expect(screen.getByText("Search failed")).toBeVisible(),
    );
    expect(screen.queryByText("No messages found")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("reports pagination failures without discarding existing results", async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    global.IntersectionObserver = jest.fn(
      (callback: IntersectionObserverCallback) => {
        intersectionCallback = callback;
        return {
          disconnect: jest.fn(),
          observe: jest.fn(),
          unobserve: jest.fn(),
        } as unknown as IntersectionObserver;
      },
    ) as unknown as typeof IntersectionObserver;

    const query = useConvex().query as jest.Mock;
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    query
      .mockResolvedValueOnce({
        page: [makeSearchResult("first", "first result")],
        isDone: false,
        continueCursor: "next-page",
      })
      .mockRejectedValueOnce(new Error("pagination unavailable"));

    render(<MessageSearchDialog isOpen={true} onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search messages..."), {
      target: { value: "billing" },
    });
    await runDebounce();
    await waitFor(() => expect(screen.getByText("first result")).toBeVisible());
    expect(intersectionCallback).toBeDefined();

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(query).toHaveBeenLastCalledWith("messages.searchMessages", {
        searchQuery: "billing",
        paginationOpts: { numItems: 10, cursor: "next-page" },
      });
      expect(
        screen.getByText("Couldn't load more results. Try searching again."),
      ).toBeVisible();
    });
    expect(screen.getByText("first result")).toBeVisible();
    consoleError.mockRestore();
  });
});
