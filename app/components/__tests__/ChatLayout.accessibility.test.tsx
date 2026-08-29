import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

let mockIsMobile = true;
let mockCompactTaskSidebar = false;
let mockChatSidebarOpen = true;
let mockComputerSidebarOpen = false;
let mockPathname = "/c/task-1";
const mockSetChatSidebarOpen = jest.fn();

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));
jest.mock("@/hooks/use-workspace-layout", () => ({
  useCompactTaskSidebar: () => mockCompactTaskSidebar,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    chatSidebarOpen: mockChatSidebarOpen,
    setChatSidebarOpen: mockSetChatSidebarOpen,
    sidebarOpen: mockComputerSidebarOpen,
  }),
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
jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({
    children,
    onOpenChange,
    open,
    persistOpenState,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    persistOpenState?: boolean;
  }) => (
    <div
      data-testid="sidebar-provider"
      data-open={open ? "true" : "false"}
      data-persist={persistOpenState ? "true" : "false"}
    >
      <button type="button" onClick={() => onOpenChange?.(true)}>
        Open task sidebar
      </button>
      {children}
    </div>
  ),
}));
jest.mock("../Sidebar", () => ({
  __esModule: true,
  default: ({
    isMobileOverlay,
    onClose,
    projectListData,
  }: {
    isMobileOverlay?: boolean;
    onClose?: () => void;
    projectListData?: { results?: unknown[] };
  }) => (
    <div
      data-testid="main-sidebar"
      data-project-count={projectListData?.results?.length}
      data-overlay={isMobileOverlay ? "true" : "false"}
    >
      Task navigation
      {onClose ? (
        <button type="button" onClick={onClose}>
          Close task sidebar
        </button>
      ) : null}
    </div>
  ),
}));
jest.mock("@/lib/utils/settings-dialog", () => ({
  onOpenSettingsDialog: () => () => undefined,
}));

const { ChatLayout } =
  require("../ChatLayout") as typeof import("../ChatLayout");

describe("ChatLayout responsive accessibility", () => {
  beforeEach(() => {
    mockIsMobile = true;
    mockCompactTaskSidebar = false;
    mockChatSidebarOpen = true;
    mockComputerSidebarOpen = false;
    mockPathname = "/c/task-1";
    mockSetChatSidebarOpen.mockReset();
  });

  it("gives the mobile task sidebar dialog an accessible name", () => {
    render(
      <ChatLayout>
        <main>Task content</main>
      </ChatLayout>,
    );

    expect(
      screen.getByRole("dialog", { name: "Task sidebar" }),
    ).toHaveAttribute("aria-modal", "true");
  });

  it("passes the persistent empty project result into the mobile sidebar", () => {
    render(
      <ChatLayout>
        <main>Task content</main>
      </ChatLayout>,
    );

    expect(screen.getByTestId("main-sidebar")).toHaveAttribute(
      "data-project-count",
      "0",
    );
  });

  it("uses a rail and opens the task sidebar as an overlay in a compact workspace", () => {
    mockIsMobile = false;
    mockCompactTaskSidebar = true;
    mockComputerSidebarOpen = true;

    render(
      <ChatLayout>
        <main>Task content</main>
      </ChatLayout>,
    );

    expect(screen.getByTestId("sidebar")).toHaveAttribute(
      "data-layout",
      "compact-rail",
    );
    expect(screen.getByTestId("sidebar")).toHaveClass("w-12");
    expect(screen.getByTestId("sidebar-provider")).toHaveAttribute(
      "data-open",
      "false",
    );
    expect(screen.getByTestId("sidebar-provider")).toHaveAttribute(
      "data-persist",
      "false",
    );
    expect(screen.queryByRole("dialog", { name: "Task sidebar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open task sidebar" }));

    expect(
      screen.getByRole("dialog", { name: "Task sidebar" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("main-sidebar").at(-1)).toHaveAttribute(
      "data-overlay",
      "true",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Task sidebar" })).toBeNull();
  });

  it("keeps the preferred expanded sidebar in a wide workspace", () => {
    mockIsMobile = false;
    mockCompactTaskSidebar = false;
    mockComputerSidebarOpen = true;

    render(
      <ChatLayout>
        <main>Task content</main>
      </ChatLayout>,
    );

    expect(screen.getByTestId("sidebar")).toHaveAttribute(
      "data-layout",
      "standard",
    );
    expect(screen.getByTestId("sidebar")).toHaveClass("w-[300px]");
    expect(screen.getByTestId("sidebar-provider")).toHaveAttribute(
      "data-open",
      "true",
    );
  });
});
