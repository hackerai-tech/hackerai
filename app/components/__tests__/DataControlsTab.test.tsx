import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConvex } from "convex/react";
import { DataControlsTab } from "../DataControlsTab";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: "pro" }),
}));
jest.mock("../AnalyticsConsentManager", () => ({
  AnalyticsConsentPreferences: () => null,
  useAnalyticsConsentPreferencesAvailable: () => false,
}));

jest.mock("../ManageSharedChatsDialog", () => ({
  ManageSharedChatsDialog: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

describe("destructive data controls", () => {
  beforeEach(() => jest.clearAllMocks());
  it("keeps bulk deletion open after acceptance until cleanup confirms completion", async () => {
    const user = userEvent.setup();
    const request = deferred<any>();
    const cleanup = deferred<any>();
    global.fetch = jest.fn().mockReturnValue(request.promise);
    (useConvex().query as jest.Mock).mockReturnValue(cleanup.promise);
    render(<DataControlsTab />);
    await user.click(screen.getByRole("button", { name: "Delete all tasks" }));
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await act(async () => request.resolve({ ok: true, status: 202 }));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(useConvex().query).toHaveBeenCalledTimes(1);
    // A cleanup failure must leave the dialog available and must not redirect.
    await act(async () => cleanup.resolve("failed"));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Confirm deletion" }),
    ).toBeEnabled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps sandbox deletion open, disables repeat clicks, then closes on confirmation", async () => {
    const request = deferred<any>();
    global.fetch = jest.fn().mockReturnValue(request.promise);
    const user = userEvent.setup();
    render(<DataControlsTab />);
    await user.click(
      screen.getByRole("button", { name: "Delete terminal sandbox" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete", exact: true }),
    );
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Deleting..." }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve({ ok: true }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });
});
