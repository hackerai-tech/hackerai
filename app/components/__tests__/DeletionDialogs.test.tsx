import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedLinksTab } from "../SharedLinksTab";
import { ManageNotesDialog } from "../ManageNotesDialog";

const mockMutation = jest.fn();
jest.mock("convex/react", () => ({
  useMutation: () => mockMutation,
  useQuery: () => [
    { id: "chat-1", title: "Shared task", share_id: "share-1", share_date: 1 },
  ],
  usePaginatedQuery: () => ({
    results: [
      { note_id: "note-1", title: "Saved note", content: "Test", tags: [] },
    ],
    status: "Exhausted",
    loadMore: jest.fn(),
  }),
}));

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  mockMutation.mockReturnValue(promise);
  return resolve;
}

beforeEach(() => jest.clearAllMocks());

it.each([false, true])(
  "keeps unsharing visible until the mutation finishes (all=%s)",
  async (all) => {
    const finish = defer();
    const user = userEvent.setup();
    render(<SharedLinksTab />);
    await user.click(
      screen.getByRole("button", {
        name: all ? "Unshare all tasks" : "Unshare task",
        exact: true,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: all ? "Unshare All" : "Unshare",
        exact: true,
      }),
    );
    expect(screen.getByRole("button", { name: "Unsharing..." })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await act(async () => finish());
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(mockMutation).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "shows note deletion progress and blocks dismissal (all=%s)",
  async (all) => {
    const finish = defer();
    const user = userEvent.setup();
    const close = jest.fn();
    render(<ManageNotesDialog open onOpenChange={close} />);
    await user.click(
      screen.getByRole("button", { name: all ? "Delete all" : "Remove note" }),
    );
    expect(
      screen.getByRole("button", { name: all ? "Deleting…" : "Removing note" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(
      screen.getByRole("button", { name: all ? "Delete all" : "Remove note" }),
    ).toBeEnabled();
    expect(mockMutation).toHaveBeenCalledTimes(1);
  },
);
