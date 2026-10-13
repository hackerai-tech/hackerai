import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import ToolBlock from "../tool-block";

describe("ToolBlock", () => {
  it("renders status-only blocks without an inert button", () => {
    render(<ToolBlock icon={<span>icon</span>} action="Preparing report" />);

    expect(screen.getByText("Preparing report")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses a semantic button and explicit accessible label when clickable", () => {
    const onClick = jest.fn();
    render(
      <ToolBlock
        icon={<span>icon</span>}
        action="Tool input needs attention"
        target="View details"
        isClickable
        onClick={onClick}
        ariaLabel="Open terminal error details"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal error details" }),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
