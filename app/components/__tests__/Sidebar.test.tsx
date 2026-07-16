import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";

let mockSidebarState: "expanded" | "collapsed" = "expanded";

jest.mock("@/components/ui/sidebar", () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );

  return {
    Sidebar: Wrapper,
    SidebarContent: Wrapper,
    SidebarFooter: Wrapper,
    SidebarGroup: Wrapper,
    SidebarGroupContent: Wrapper,
    SidebarHeader: Wrapper,
    SidebarRail: () => null,
    useSidebar: () => ({ state: mockSidebarState }),
  };
});
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ setChatSidebarOpen: jest.fn() }),
}));
jest.mock("@/app/hooks/useChats", () => ({
  useChats: () => ({
    results: [],
    status: "Exhausted",
    loadMore: jest.fn(),
  }),
}));
jest.mock("@/app/hooks/useProjects", () => ({
  useProjects: () => ({
    results: [],
    status: "Exhausted",
    loadMore: jest.fn(),
  }),
}));
jest.mock("../SidebarHeader", () => ({
  __esModule: true,
  default: () => <div>Header</div>,
}));
jest.mock("../SidebarUserNav", () => ({
  __esModule: true,
  default: () => <div>Footer</div>,
}));
jest.mock("../SidebarChatSections", () => ({
  SidebarChatSections: () => (
    <div data-testid="sidebar-chat-sections">Task sections</div>
  ),
}));

const MainSidebar = require("../Sidebar")
  .default as typeof import("../Sidebar").default;

const chatListData = {
  results: [{ _id: "chat-doc", id: "chat-1", title: "Target notes" }],
  status: "Exhausted" as const,
  loadMore: jest.fn(),
};

describe("MainSidebar", () => {
  it("keeps task content mounted but hidden while the sidebar is collapsed", () => {
    mockSidebarState = "expanded";
    const { rerender } = render(<MainSidebar chatListData={chatListData} />);

    const expandedContent = screen.getByTestId("sidebar-chat-list-visibility");
    expect(expandedContent).toHaveClass("visible", "opacity-100", "delay-200");
    expect(expandedContent).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("sidebar-chat-sections")).toBeInTheDocument();

    mockSidebarState = "collapsed";
    rerender(<MainSidebar chatListData={chatListData} />);

    const collapsedContent = screen.getByTestId("sidebar-chat-list-visibility");
    expect(collapsedContent).toHaveClass(
      "pointer-events-none",
      "invisible",
      "opacity-0",
    );
    expect(collapsedContent).toHaveAttribute("aria-hidden", "true");
    expect(collapsedContent).toHaveAttribute("inert");
    expect(screen.getByTestId("sidebar-chat-sections")).toBeInTheDocument();
  });
});
