import { act, fireEvent, render, screen } from "@testing-library/react";
import { setMockQueryResult } from "@/__mocks__/convex-react";
import { useMutation } from "convex/react";
import { PersonalizationTab } from "../PersonalizationTab";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
describe("prediction preference settings", () => {
  const save = useMutation({} as never) as jest.Mock;
  const view = () => (
    <PersonalizationTab
      onCustomInstructions={() => {}}
      onManageNotes={() => {}}
    />
  );
  beforeEach(() => {
    jest.clearAllMocks();
    save.mockReset();
    setMockQueryResult({ enabled: true });
  });
  it.each([undefined, null])(
    "disables the switch until an account preference resolves: %s",
    (value) => {
      setMockQueryResult(value);
      render(view());
      expect(
        screen.getByRole("switch", { name: "Show predictions" }),
      ).toBeDisabled();
    },
  );
  it("saves opt-out once, shows saving, and retains off after reopening", async () => {
    let resolve!: () => void;
    save.mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(view());
    const control = screen.getByRole("switch", { name: "Show predictions" });
    expect(control).toBeChecked();
    fireEvent.click(control);
    fireEvent.click(control);
    expect(control).toBeDisabled();
    expect(control).not.toBeChecked();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ enabled: false });
    await act(async () => {
      setMockQueryResult({ enabled: false });
      resolve();
    });
    unmount();
    render(view());
    expect(
      screen.getByRole("switch", { name: "Show predictions" }),
    ).not.toBeChecked();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "contextual_next_actions_preference_changed",
      { enabled: false, definition_version: 1 },
    );
  });
  it("failed save keeps saved state and allows retry without reporting a false preference change", async () => {
    save.mockRejectedValueOnce(new Error("unavailable"));
    render(view());
    fireEvent.click(screen.getByRole("switch", { name: "Show predictions" }));
    await screen.findByRole("alert");
    expect(
      screen.getByRole("switch", { name: "Show predictions" }),
    ).toBeChecked();
    expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
    save.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("switch", { name: "Show predictions" }));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(2);
  });
});
