import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    chatSidebarOpen: true,
    setChatSidebarOpen: jest.fn(),
  }),
}));
jest.mock("@/app/hooks/useChats", () => ({
  useChats: () => ({
    results: [],
    status: "Exhausted",
    loadMore: jest.fn(),
  }),
}));
jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
jest.mock("../Sidebar", () => ({
  __esModule: true,
  default: () => <div>Task navigation</div>,
}));
jest.mock("@/lib/utils/settings-dialog", () => ({
  onOpenSettingsDialog: () => () => undefined,
}));

const { ChatLayout } =
  require("../ChatLayout") as typeof import("../ChatLayout");

describe("ChatLayout mobile accessibility", () => {
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
});
