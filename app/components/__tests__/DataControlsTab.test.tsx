import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConvex, useMutation } from "convex/react";
import { setMockQueryResult } from "@/__mocks__/convex-react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { DataControlsTab } from "../DataControlsTab";

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  },
}));

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
  beforeEach(() => {
    jest.clearAllMocks();
    setMockQueryResult(undefined);
  });
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

describe("model improvement control", () => {
  const save = useMutation(
    api.userCustomization.setModelImprovementPreference,
  ) as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    save.mockReset();
    setMockQueryResult({ enabled: true, updatedAt: null });
  });

  it("shows the server default on", () => {
    render(<DataControlsTab />);
    expect(
      screen.getByRole("switch", { name: "Improve the model for everyone" }),
    ).toBeChecked();
  });

  it.each([undefined, null])(
    "disables the control while the preference is unavailable: %s",
    (value) => {
      setMockQueryResult(value);
      render(<DataControlsTab />);
      const control = screen.getByRole("switch", {
        name: "Improve the model for everyone",
      });
      expect(control).toBeDisabled();
      expect(control).not.toBeChecked();
    },
  );

  it("saves off, prevents repeated changes while saving, and displays the confirmed value after reopening", async () => {
    const user = userEvent.setup();
    const request = deferred<null>();
    save.mockReturnValue(request.promise);
    const view = render(<DataControlsTab />);
    await user.click(
      screen.getByRole("switch", { name: "Improve the model for everyone" }),
    );
    expect(save).toHaveBeenCalledWith({ enabled: false });
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    await user.click(screen.getByRole("switch"));
    expect(save).toHaveBeenCalledTimes(1);
    setMockQueryResult({ enabled: false, updatedAt: 123 });
    await act(async () => request.resolve(null));
    expect(screen.getByRole("switch")).not.toBeChecked();
    view.unmount();
    render(<DataControlsTab />);
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it.each([false, true])(
    "preserves %s after a failed save and allows retry",
    async (enabled) => {
      setMockQueryResult({ enabled, updatedAt: 123 });
      save.mockRejectedValueOnce(new Error("Network failure"));
      const user = userEvent.setup();
      render(<DataControlsTab />);
      await user.click(
        screen.getByRole("switch", { name: "Improve the model for everyone" }),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Couldn't save your model improvement preference. Please try again.",
        ),
      );
      expect(save).toHaveBeenCalledWith({ enabled: !enabled });
      expect(screen.getByRole("switch")).toHaveAttribute(
        "aria-checked",
        String(enabled),
      );
      expect(screen.getByRole("switch")).toBeEnabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your change wasn't saved. The switch shows your saved preference.",
      );
      save.mockImplementationOnce(async () => {
        setMockQueryResult({ enabled: !enabled, updatedAt: 456 });
        return null;
      });
      await user.click(
        screen.getByRole("button", { name: "Retry saving preference" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      expect(save).toHaveBeenLastCalledWith({ enabled: !enabled });
      expect(screen.getByRole("switch")).toHaveAttribute(
        "aria-checked",
        String(!enabled),
      );
    },
  );
});

describe("model improvement synchronization", () => {
  it("reflects changes from another session without writing a default during loading or sign-out", () => {
    const save = useMutation(
      api.userCustomization.setModelImprovementPreference,
    ) as jest.Mock;
    save.mockClear();
    setMockQueryResult({ enabled: false, updatedAt: 123 });
    const view = render(<DataControlsTab />);
    expect(screen.getByRole("switch")).not.toBeChecked();
    setMockQueryResult(undefined);
    view.rerender(<DataControlsTab />);
    expect(screen.getByRole("switch")).toBeDisabled();
    setMockQueryResult(null);
    view.rerender(<DataControlsTab />);
    expect(screen.getByRole("switch")).toBeDisabled();
    setMockQueryResult({ enabled: false, updatedAt: 123 });
    view.rerender(<DataControlsTab />);
    expect(screen.getByRole("switch")).not.toBeChecked();
    setMockQueryResult({ enabled: true, updatedAt: 456 });
    view.rerender(<DataControlsTab />);
    expect(screen.getByRole("switch")).toBeChecked();
    expect(save).not.toHaveBeenCalled();
  });
});
