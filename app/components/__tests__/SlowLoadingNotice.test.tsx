import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { SlowLoadingNotice } from "../SlowLoadingNotice";

describe("SlowLoadingNotice", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("allows normal loading, then offers recovery after 15 seconds", () => {
    render(<SlowLoadingNotice label="Loading task history…" />);
    expect(screen.getByText("Loading task history…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(15_000));
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(
      screen.getByText("This is taking longer than expected."),
    ).toBeInTheDocument();
  });

  it("cleans up the timer when loading completes", () => {
    const { unmount } = render(<SlowLoadingNotice />);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
