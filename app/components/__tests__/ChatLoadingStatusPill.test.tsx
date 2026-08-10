import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { ChatLoadingStatusPill } from "../ChatLoadingStatusPill";

describe("ChatLoadingStatusPill", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits 300ms before showing an accessible, non-animated status", () => {
    jest.useFakeTimers();
    const { container } = render(<ChatLoadingStatusPill />);

    expect(
      screen.queryByRole("status", { name: "Loading messages..." }),
    ).not.toBeInTheDocument();

    act(() => jest.advanceTimersByTime(299));
    expect(
      screen.queryByRole("status", { name: "Loading messages..." }),
    ).not.toBeInTheDocument();

    act(() => jest.advanceTimersByTime(1));
    expect(
      screen.getByRole("status", { name: "Loading messages..." }),
    ).toHaveTextContent("Loading messages...");
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });
});
