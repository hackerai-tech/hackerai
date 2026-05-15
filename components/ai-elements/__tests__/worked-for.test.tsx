import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  WorkedFor,
  WorkedForContent,
  WorkedForTrigger,
  formatDuration,
} from "../worked-for";

describe("formatDuration", () => {
  it("rounds sub-second durations up to 1s", () => {
    expect(formatDuration(0)).toBe("1s");
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(499)).toBe("1s");
    expect(formatDuration(999)).toBe("1s");
  });

  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(23_400)).toBe("23s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("formats >=1m durations as minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(96_000)).toBe("1m 36s");
    expect(formatDuration(120_000)).toBe("2m 0s");
    expect(formatDuration(3_661_000)).toBe("61m 1s");
  });

  it("guards against non-finite or negative inputs", () => {
    expect(formatDuration(Number.NaN)).toBe("1s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("1s");
    expect(formatDuration(-500)).toBe("1s");
  });
});

describe("WorkedFor", () => {
  it("shows a live working timer while timing", () => {
    jest.useFakeTimers();
    let now = 0;
    const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);

    render(
      <WorkedFor hasWork defaultOpen>
        <WorkedForTrigger isTiming />
        <WorkedForContent>Hidden work</WorkedForContent>
      </WorkedFor>,
    );

    expect(
      screen.getByRole("button", { name: /working for 1s/i }),
    ).toBeInTheDocument();

    act(() => {
      now = 23_400;
      jest.advanceTimersByTime(1000);
    });

    expect(
      screen.getByRole("button", { name: /working for 23s/i }),
    ).toBeInTheDocument();

    dateNowSpy.mockRestore();
    jest.useRealTimers();
  });

  it("uses a persisted start timestamp for the live timer", () => {
    jest.useFakeTimers();
    let now = 30_000;
    const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);

    render(
      <WorkedFor hasWork defaultOpen>
        <WorkedForTrigger isTiming startedAt={5_000} />
        <WorkedForContent>Hidden work</WorkedForContent>
      </WorkedFor>,
    );

    expect(
      screen.getByRole("button", { name: /working for 25s/i }),
    ).toBeInTheDocument();

    act(() => {
      now = 42_000;
      jest.advanceTimersByTime(1000);
    });

    expect(
      screen.getByRole("button", { name: /working for 37s/i }),
    ).toBeInTheDocument();

    dateNowSpy.mockRestore();
    jest.useRealTimers();
  });

  it("does not allow collapsing or show a chevron while timing", () => {
    const { container } = render(
      <WorkedFor hasWork defaultOpen>
        <WorkedForTrigger isTiming />
        <WorkedForContent>Hidden work</WorkedForContent>
      </WorkedFor>,
    );

    const trigger = screen.getByRole("button", { name: /working for 1s/i });

    expect(trigger).toBeDisabled();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.getByText("Hidden work")).toBeVisible();

    fireEvent.click(trigger);

    expect(screen.getByText("Hidden work")).toBeVisible();
  });

  it("does not render lazy content until opened", () => {
    const renderContent = jest.fn(() => "Hidden work");

    render(
      <WorkedFor hasWork>
        <WorkedForTrigger durationMs={1_000} />
        <WorkedForContent lazy>{renderContent}</WorkedForContent>
      </WorkedFor>,
    );

    expect(renderContent).not.toHaveBeenCalled();
    expect(screen.queryByText("Hidden work")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /worked for 1s/i }));

    expect(renderContent).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Hidden work")).toBeVisible();
  });

  it("keeps the nearest scroll container at the same position when toggled", () => {
    let now = 0;
    const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    const requestAnimationFrameSpy = jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        now += 500;
        callback(now);
        return 1;
      });

    render(
      <div data-testid="scroll-container">
        <div style={{ height: 400 }} />
        <WorkedFor hasWork>
          <WorkedForTrigger durationMs={1_000} />
          <WorkedForContent>
            <div style={{ height: 800 }}>Hidden work</div>
          </WorkedForContent>
        </WorkedFor>
      </div>,
    );

    const scrollContainer = screen.getByTestId("scroll-container");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_200 },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      writable: true,
      value: 260,
    });
    Object.defineProperty(scrollContainer, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 0,
    });
    const trigger = screen.getByRole("button", { name: /worked for 1s/i });
    const getComputedStyleSpy = jest
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ overflowY: "auto" } as CSSStyleDeclaration);
    fireEvent.pointerDown(trigger);
    scrollContainer.scrollTop = 900;

    act(() => {
      fireEvent.click(trigger);
    });

    expect(scrollContainer.scrollTop).toBe(260);
    getComputedStyleSpy.mockRestore();
    requestAnimationFrameSpy.mockRestore();
    dateNowSpy.mockRestore();
  });
});
