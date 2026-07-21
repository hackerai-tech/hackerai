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

describe("MessageSearchDialog", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
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
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

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
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
