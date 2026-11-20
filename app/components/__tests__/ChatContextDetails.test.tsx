import "@testing-library/jest-dom";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  CONTEXT_DETAILS_STORAGE_KEY,
  useContextDetailsPreference,
} from "@/app/hooks/useContextDetailsPreference";
import { ChatContextDetails } from "@/app/components/ChatContextDetails";
import {
  getContextPressurePercent,
  selectLatestContextPressure,
} from "@/lib/chat/context-pressure";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
});

const trigger = () => screen.getByTestId("context-details-trigger");

describe("selectLatestContextPressure", () => {
  const usage = (data: unknown) => ({
    type: "data-context-usage",
    id: "context-usage",
    data,
  });
  const assistant = (...parts: unknown[]) => ({ role: "assistant", parts });

  it("reads the latest measured request and never reinterprets legacy or invalid parts", () => {
    const measured = {
      usedTokens: 357_000,
      compactionThresholdTokens: 475_000,
    };
    // A response that has not measured yet keeps the previous measurement.
    expect(
      selectLatestContextPressure([
        assistant({ type: "text", text: "Earlier" }, usage(measured)),
        assistant({ type: "text", text: "Working" }),
      ]),
    ).toEqual(measured);
    expect(getContextPressurePercent(measured)).toBe(75);

    expect(
      selectLatestContextPressure([
        assistant(
          // Legacy capacity snapshots are not where compaction happens.
          usage({ usedTokens: 50_000, maxTokens: 128_000 }),
          usage({ usedTokens: 0, compactionThresholdTokens: 200_000 }),
          usage({ usedTokens: 1.5, compactionThresholdTokens: 200_000 }),
          usage({ usedTokens: "10", compactionThresholdTokens: 200_000 }),
          usage({ usedTokens: 10, compactionThresholdTokens: 0 }),
          usage(null),
        ),
        { role: "user", parts: [usage(measured)] },
      ]),
    ).toBeNull();
  });
});

describe("useContextDetailsPreference", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps this tab's choice when saving fails but reading still works", () => {
    const { result } = renderHook(() => useContextDetailsPreference());
    expect(result.current[0]).toBe(false);
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      act(() => result.current[1](true));
      expect(window.localStorage.getItem(CONTEXT_DETAILS_STORAGE_KEY)).toBe(
        null,
      );
      expect(result.current[0]).toBe(true);
    } finally {
      setItem.mockRestore();
    }

    // A later successful write clears the fallback and is stored normally.
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(window.localStorage.getItem(CONTEXT_DETAILS_STORAGE_KEY)).toBe(
      "true",
    );
    act(() => result.current[1](false));
  });
});

describe("ChatContextDetails", () => {
  const summary = "Context: 62% of compaction threshold, 124k / 200k tokens";

  it("previews on keyboard focus and opens measured details with Enter", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatContextDetails
        snapshot={{ usedTokens: 124_000, compactionThresholdTokens: 200_000 }}
        completedCompactions={2}
      />,
    );

    await user.tab();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName(summary);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(summary);
    // The passive preview shows usage against the threshold, never the count.
    expect(screen.getByText("124k / 200k tokens")).toBeInTheDocument();
    expect(screen.queryByText(/compactions/i)).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    const details = screen.getByRole("dialog", { name: "Agent context" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(details).toHaveTextContent("62% of compaction threshold");
    expect(details).toHaveTextContent("124k / 200k tokens · last request");
    expect(details).toHaveTextContent("Completed compactions2");

    // A later step replaces the measurement in place.
    rerender(
      <ChatContextDetails
        snapshot={{ usedTokens: 210_000, compactionThresholdTokens: 200_000 }}
        completedCompactions={2}
      />,
    );
    // Text stays honest above the threshold; only the ring fill is capped.
    expect(details).toHaveTextContent("105% of compaction threshold");
    expect(details).toHaveTextContent("210k / 200k tokens");
    expect(screen.getByTestId("context-meter-ring")).toHaveAttribute(
      "data-fill",
      "1.00",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("opens by tap without inventing a zero count for an unrecorded history", async () => {
    const user = userEvent.setup();
    // A chat measured now whose earlier compactions were never recorded.
    render(
      <ChatContextDetails
        snapshot={{ usedTokens: 36_000, compactionThresholdTokens: 200_000 }}
      />,
    );

    await user.click(trigger());
    const details = screen.getByRole("dialog", { name: "Agent context" });
    expect(details).toHaveTextContent("18% of compaction threshold");
    expect(details).toHaveTextContent("Completed compactionsUnavailable");
    expect(screen.getByTestId("context-meter-ring")).toHaveAttribute(
      "data-fill",
      "0.18",
    );
  });
});
