import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";

const mockToggleSidebar = jest.fn();

jest.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ toggleSidebar: mockToggleSidebar }),
}));
jest.mock("@/components/icons/hackerai-svg", () => ({
  HackerAISVG: () => <div data-testid="hackerai-svg" />,
}));
jest.mock("@/app/hooks/useChats", () => ({
  useChats: jest.fn(),
}));
jest.mock("@/app/hooks/useStartNewChat", () => ({
  useStartNewChat: () => jest.fn(),
}));
jest.mock("../MessageSearchDialog", () => ({
  MessageSearchDialog: () => null,
}));

const SidebarHeaderContent = require("../SidebarHeader")
  .default as typeof import("../SidebarHeader").default;

describe("SidebarHeaderContent", () => {
  it("shows the sidebar button instead of the HackerAI icon when collapsed", () => {
    render(
      <SidebarHeaderContent
        handleCloseSidebar={jest.fn()}
        isCollapsed={true}
      />,
    );

    const expandButton = screen.getByRole("button", {
      name: "Expand sidebar",
    });

    expect(screen.queryByTestId("hackerai-svg")).not.toBeInTheDocument();
    expect(expandButton.querySelector("svg")).toBeInTheDocument();

    expect(mockToggleSidebar).not.toHaveBeenCalled();
    fireEvent.click(expandButton);
    expect(mockToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
