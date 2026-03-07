import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "@jest/globals";
import { render, screen } from "@testing-library/react";

const mockUseDataStream = jest.fn();

jest.mock("@/app/components/DataStreamProvider", () => ({
  useDataStream: (...args: unknown[]) => mockUseDataStream(...args),
}));

import { FinishReasonNotice } from "../FinishReasonNotice";

describe("FinishReasonNotice", () => {
  beforeEach(() => {
    mockUseDataStream.mockReturnValue({
      isAutoResuming: false,
      autoContinueCount: 5,
      dataStream: [],
      setDataStream: jest.fn(),
      setIsAutoResuming: jest.fn(),
    });
  });

  it("returns null when isAutoResuming is true", () => {
    mockUseDataStream.mockReturnValue({
      isAutoResuming: true,
      dataStream: [],
      setDataStream: jest.fn(),
      setIsAutoResuming: jest.fn(),
    });

    const { container } = render(
      <FinishReasonNotice finishReason="length" mode="agent" />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("returns null when finishReason is undefined", () => {
    const { container } = render(
      <FinishReasonNotice finishReason={undefined} mode="agent" />,
    );

    expect(container.innerHTML).toBe("");
  });

  it.each([
    {
      finishReason: "tool-calls",
      expectedText: "I automatically stopped to prevent going off course",
    },
    {
      finishReason: "timeout",
      expectedText: "I had to stop due to the time limit",
    },
    {
      finishReason: "length",
      expectedText: "I hit the output token limit and had to stop",
    },
    {
      finishReason: "context-limit",
      expectedText:
        "I reached the context limit for this conversation after summarizing",
    },
  ])(
    "renders notice for finishReason=$finishReason when isAutoResuming is false",
    ({ finishReason, expectedText }) => {
      render(<FinishReasonNotice finishReason={finishReason} mode="agent" />);

      expect(screen.getByText(new RegExp(expectedText))).toBeInTheDocument();
    },
  );

  it("returns null when autoContinueCount is under the limit (auto-continue pending)", () => {
    // Replicates the race: finishReason arrives from Convex before
    // isAutoResuming is set. But autoContinueCount < MAX means
    // another auto-continue will fire — suppress the notice.
    mockUseDataStream.mockReturnValue({
      isAutoResuming: false,
      autoContinueCount: 0,
      dataStream: [],
      setDataStream: jest.fn(),
      setIsAutoResuming: jest.fn(),
    });

    const { container } = render(
      <FinishReasonNotice finishReason="context-limit" mode="agent" />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("shows notice when autoContinueCount has reached MAX_AUTO_CONTINUES", () => {
    mockUseDataStream.mockReturnValue({
      isAutoResuming: false,
      autoContinueCount: 5,
      dataStream: [],
      setDataStream: jest.fn(),
      setIsAutoResuming: jest.fn(),
    });

    render(<FinishReasonNotice finishReason="context-limit" mode="agent" />);

    expect(screen.getByText(/I reached the context limit/)).toBeInTheDocument();
  });

  it("returns null for an unknown finishReason", () => {
    const { container } = render(
      <FinishReasonNotice finishReason="unknown-reason" mode="agent" />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders with correct styling classes", () => {
    render(<FinishReasonNotice finishReason="length" mode="agent" />);

    const notice = screen
      .getByText(/I hit the output token limit/)
      .closest("div.bg-muted");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveClass("rounded-lg", "px-3", "py-2");
  });
});
