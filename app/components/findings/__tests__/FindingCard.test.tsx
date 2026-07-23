import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { FindingCard } from "../FindingCard";

describe("FindingCard", () => {
  it("is non-clickable when rendered for a public share", () => {
    render(
      <FindingCard
        title="Confirmed IDOR"
        target="app.example.test"
        severity="high"
        cvssScore={7.1}
      />,
    );
    expect(screen.getByText("Confirmed IDOR")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens an authenticated finding when clickable", () => {
    const onClick = jest.fn();
    render(
      <FindingCard
        title="Confirmed IDOR"
        target="app.example.test"
        severity="high"
        cvssScore={7.1}
        onClick={onClick}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open finding: Confirmed IDOR" }),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
