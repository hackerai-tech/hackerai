import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SummarizationStatusDivider } from "../SummarizationStatusDivider";

describe("SummarizationStatusDivider", () => {
  it("renders completed compaction as a left-aligned icon and label without divider lines", () => {
    render(<SummarizationStatusDivider status="completed" />);

    const status = screen.getByTestId("summarization-status");
    const icon = screen.getByTestId("summarization-status-icon");

    expect(status).toHaveClass("w-full", "items-center", "gap-2");
    expect(status).not.toHaveClass("justify-center");
    expect(status.querySelector(".bg-border")).not.toBeInTheDocument();
    expect(icon).toHaveClass("lucide-notebook-text");
    expect(screen.getByText("Context automatically compacted")).toBeVisible();
  });

  it("keeps the active compaction message left-aligned and live", () => {
    render(<SummarizationStatusDivider status="started" />);

    const status = screen.getByTestId("summarization-status");

    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Automatically compacting context")).toBeVisible();
    expect(
      screen.queryByTestId("summarization-status-icon"),
    ).not.toBeInTheDocument();
  });
});
