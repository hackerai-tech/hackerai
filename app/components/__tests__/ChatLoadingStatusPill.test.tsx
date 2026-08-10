import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ChatLoadingStatusPill } from "../ChatLoadingStatusPill";

describe("ChatLoadingStatusPill", () => {
  it("shows an accessible, non-animated loading status", () => {
    const { container } = render(<ChatLoadingStatusPill />);

    expect(
      screen.getByRole("status", { name: "Loading messages..." }),
    ).toHaveTextContent("Loading messages...");
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });
});
