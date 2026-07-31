import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SubscriptionTier } from "@/types";

const mockToggleSidebar = jest.fn();
const mockStartNewChat = jest.fn();
let mockSubscription: SubscriptionTier = "free";
let mockIsCheckingProPlan = false;

jest.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ toggleSidebar: mockToggleSidebar }),
}));
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
jest.mock("@/components/icons/hackerai-svg", () => ({
  HackerAISVG: ({ scale }: { scale?: number }) => (
    <div data-testid="hackerai-svg" data-scale={scale} />
  ),
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    isCheckingProPlan: mockIsCheckingProPlan,
  }),
}));
jest.mock("@/app/hooks/useChats", () => ({
  useChats: jest.fn(),
}));
jest.mock("@/app/hooks/useStartNewChat", () => ({
  useStartNewChat: () => mockStartNewChat,
}));
jest.mock("../MessageSearchDialog", () => ({
  MessageSearchDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">Task search</div> : null,
}));

const SidebarHeaderContent = require("../SidebarHeader")
  .default as typeof import("../SidebarHeader").default;

describe("SidebarHeaderContent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscription = "free";
    mockIsCheckingProPlan = false;
  });

  it("shows the sidebar button instead of the HackerAI icon when collapsed", () => {
    render(
      <SidebarHeaderContent
        handleCloseSidebar={jest.fn()}
        isCollapsed={true}
      />,
    );

    const expandButton = screen.getByRole("button", {
      name: "Open sidebar",
    });

    expect(screen.queryByTestId("hackerai-svg")).not.toBeInTheDocument();
    expect(expandButton.querySelector("svg")).toBeInTheDocument();
    expect(expandButton).toHaveClass("size-9");
    expect(expandButton.querySelector("svg")).toHaveClass("size-[18px]");

    const newTaskButton = screen.getByRole("button", {
      name: "Start new task",
    });
    const searchButton = screen.getByRole("button", { name: "Search" });

    expect(newTaskButton).toHaveClass("size-9");
    expect(newTaskButton.querySelector("svg")).toHaveClass("size-[18px]");
    expect(searchButton).toHaveClass("size-9");
    expect(searchButton.querySelector("svg")).toHaveClass("size-[18px]");

    expect(mockToggleSidebar).not.toHaveBeenCalled();
    fireEvent.click(expandButton);
    expect(mockToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("shows only the HackerAI mark for free users", () => {
    render(
      <SidebarHeaderContent
        handleCloseSidebar={jest.fn()}
        isCollapsed={false}
      />,
    );

    const homeLink = screen.getByRole("link", { name: "HackerAI home" });

    expect(homeLink).toContainElement(screen.getByTestId("hackerai-svg"));
    expect(screen.queryByText("HackerAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Free")).not.toBeInTheDocument();
  });

  it.each<[SubscriptionTier, string]>([
    ["pro", "Pro"],
    ["pro-plus", "Pro+"],
    ["ultra", "Ultra"],
    ["team", "Team"],
  ])("shows the %s subscription in the header", (subscription, label) => {
    mockSubscription = subscription;

    render(
      <SidebarHeaderContent
        handleCloseSidebar={jest.fn()}
        isCollapsed={false}
      />,
    );

    expect(
      screen.getByRole("link", { name: `HackerAI ${label} home` }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("hackerai-svg")).not.toBeInTheDocument();
    expect(screen.getByText("HackerAI")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("uses icon-only branding and roomier spacing in the mobile overlay", () => {
    mockSubscription = "pro";
    const handleCloseSidebar = jest.fn();

    render(
      <SidebarHeaderContent
        handleCloseSidebar={handleCloseSidebar}
        isCollapsed={false}
        isMobileOverlay={true}
      />,
    );

    const homeLink = screen.getByRole("link", {
      name: "HackerAI Pro home",
    });
    const logo = screen.getByTestId("hackerai-svg");

    expect(homeLink).toContainElement(logo);
    expect(logo).toHaveAttribute("data-scale", "0.11");
    expect(screen.queryByText("HackerAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-top-header")).toHaveClass(
      "h-14",
      "ps-3",
      "pe-2.5",
    );
    expect(
      screen.getByRole("button", { name: "Start new task" }).parentElement
        ?.parentElement,
    ).toHaveClass("px-2");

    fireEvent.click(homeLink);
    expect(handleCloseSidebar).toHaveBeenCalledTimes(1);
  });

  it("moves search into the header and closes the sidebar from its icon", () => {
    const handleCloseSidebar = jest.fn();

    render(
      <SidebarHeaderContent
        handleCloseSidebar={handleCloseSidebar}
        isCollapsed={false}
      />,
    );

    expect(screen.queryByText("Search tasks")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("dialog", { name: "" })).toHaveTextContent(
      "Task search",
    );

    const closeButton = screen.getByRole("button", { name: "Close sidebar" });

    expect(closeButton).not.toHaveClass("cursor-pointer");
    expect(closeButton).not.toHaveClass("cursor-w-resize");

    fireEvent.click(closeButton);
    expect(handleCloseSidebar).toHaveBeenCalledTimes(1);
  });
});
