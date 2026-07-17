import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SidebarHeader from "../SidebarHeader";

let pathname = "/findings";

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("@/app/hooks/useChats", () => ({ useChats: jest.fn() }));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    setChatSidebarOpen: jest.fn(),
    closeSidebar: jest.fn(),
    initializeNewChat: jest.fn(),
    setTemporaryChatsEnabled: jest.fn(),
  }),
}));
jest.mock("../MessageSearchDialog", () => ({
  MessageSearchDialog: () => null,
}));

describe("SidebarHeader findings navigation", () => {
  afterEach(() => {
    pathname = "/findings";
  });

  it.each([true, false])(
    "marks the findings destination as current when collapsed is %s",
    (isCollapsed) => {
      render(
        <SidebarHeader
          handleCloseSidebar={jest.fn()}
          isCollapsed={isCollapsed}
          isMobileOverlay
        />,
      );

      expect(
        screen.getByRole("button", { name: "Open findings" }),
      ).toHaveAttribute("aria-current", "page");
    },
  );

  it("does not mark findings current on another route", () => {
    pathname = "/";
    render(
      <SidebarHeader
        handleCloseSidebar={jest.fn()}
        isCollapsed={false}
        isMobileOverlay
      />,
    );

    expect(
      screen.getByRole("button", { name: "Open findings" }),
    ).not.toHaveAttribute("aria-current");
  });
});
