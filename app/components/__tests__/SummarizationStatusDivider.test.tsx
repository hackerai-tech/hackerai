import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { SummarizationStatusDivider } from "../SummarizationStatusDivider";

describe("SummarizationStatusDivider", () => {
  afterEach(() => jest.useRealTimers());

  it("reveals details after five seconds and longer-wait guidance after thirty", () => {
    jest.useFakeTimers();
    render(
      <SummarizationStatusDivider status="started" startedAt={Date.now()} />,
    );
    expect(screen.getByText("Preparing to continue…")).toBeVisible();
    expect(
      screen.queryByLabelText("Time spent preparing"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Summarizing earlier messages/),
    ).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(4999));
    expect(
      screen.queryByLabelText("Time spent preparing"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Summarizing earlier messages/),
    ).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.getByText("5s")).toBeVisible();
    expect(screen.getByText(/Summarizing earlier messages/)).toBeVisible();
    act(() => jest.advanceTimersByTime(24_000));
    expect(
      screen.queryByText(/taking longer than usual/),
    ).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByText(/taking longer than usual/)).toBeVisible();
  });

  it("never reveals delayed details when compaction finishes quickly", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      <SummarizationStatusDivider status="started" startedAt={Date.now()} />,
    );
    act(() => jest.advanceTimersByTime(3000));
    rerender(<SummarizationStatusDivider status="completed" />);
    act(() => jest.advanceTimersByTime(30_000));
    expect(screen.getByText("Context automatically compacted")).toBeVisible();
    expect(
      screen.queryByLabelText("Time spent preparing"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Summarizing earlier messages/),
    ).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps elapsed time through retry updates and cleans up on completion", () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    const { rerender } = render(
      <SummarizationStatusDivider status="started" startedAt={startedAt} />,
    );
    act(() => jest.advanceTimersByTime(31_000));
    expect(screen.getByText("31s")).toBeVisible();
    expect(screen.getByText(/taking longer than usual/)).toBeVisible();
    rerender(
      <SummarizationStatusDivider
        status="started"
        startedAt={startedAt}
        message="Retrying preparation…"
      />,
    );
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByText("32s")).toBeVisible();
    expect(screen.getByText("Retrying preparation…")).toBeVisible();
    rerender(<SummarizationStatusDivider status="completed" />);
    expect(screen.queryByText("32s")).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("restores elapsed time after remount and resets for a new compaction", () => {
    jest.useFakeTimers();
    const { rerender, unmount } = render(
      <SummarizationStatusDivider
        status="started"
        startedAt={Date.now() - 45_000}
      />,
    );
    expect(screen.getByText("45s")).toBeVisible();
    rerender(
      <SummarizationStatusDivider status="started" startedAt={Date.now()} />,
    );
    expect(
      screen.queryByLabelText("Time spent preparing"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Summarizing earlier messages/),
    ).not.toBeInTheDocument();
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("shows a failure without a success icon or active timer", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      <SummarizationStatusDivider status="started" startedAt={Date.now()} />,
    );
    act(() => jest.advanceTimersByTime(5000));
    rerender(<SummarizationStatusDivider status="failed" />);
    expect(screen.getByText(/Couldn’t summarize/)).toBeVisible();
    expect(screen.getByTestId("summarization-status")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(
      screen.queryByLabelText("Time spent preparing"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Context automatically compacted"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("summarization-status-icon"),
    ).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
  });
  it("renders completed compaction as a left-aligned icon and label without divider lines", () => {
    render(<SummarizationStatusDivider status="completed" />);

    const status = screen.getByTestId("summarization-status");
    const icon = screen.getByTestId("summarization-status-icon");

    expect(status).toHaveClass("w-full", "items-center", "gap-2");
    expect(status).not.toHaveClass("my-4");
    expect(status).not.toHaveClass("justify-center");
    expect(status.querySelector(".bg-border")).not.toBeInTheDocument();
    expect(icon).toHaveClass("lucide-notebook-text");
    expect(screen.getByText("Context automatically compacted")).toBeVisible();
  });

  it("keeps the active compaction message left-aligned and live", () => {
    render(<SummarizationStatusDivider status="started" />);

    const status = screen.getByTestId("summarization-status");

    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Preparing to continue…")).toBeVisible();
    expect(
      screen.queryByTestId("summarization-status-icon"),
    ).not.toBeInTheDocument();
  });
});
