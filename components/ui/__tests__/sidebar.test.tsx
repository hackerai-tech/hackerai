import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
  SidebarRail,
} from "../sidebar";

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/lib/utils/sidebar-storage", () => ({
  STORAGE_KEYS: {
    MAIN_SIDEBAR: "main-sidebar",
  },
  mainSidebarStorage: {
    get: jest.fn(() => true),
    save: jest.fn(),
  },
}));

describe("SidebarProvider", () => {
  it("uses a 52px collapsed sidebar width", () => {
    const { container } = render(
      <SidebarProvider open={false} onOpenChange={jest.fn()}>
        <Sidebar collapsible="icon">
          <SidebarContent />
        </Sidebar>
      </SidebarProvider>,
    );

    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]');
    const sidebar = container.querySelector(
      '[data-slot="sidebar"][data-state="collapsed"]',
    );
    const sidebarGap = sidebar?.querySelector('[data-slot="sidebar-gap"]');
    const sidebarContainer = sidebar?.querySelector(
      '[data-slot="sidebar-container"]',
    );

    expect(sidebar).toHaveAttribute("data-collapsible", "icon");
    expect(wrapper).toHaveStyle({
      "--sidebar-width-icon": "3.25rem",
    });
    expect(sidebarGap).toHaveClass(
      "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
    );
    expect(sidebarContainer).toHaveClass(
      "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
    );
  });

  it("ignores keydown events without a string key", () => {
    const onOpenChange = jest.fn();

    render(
      <SidebarProvider open={true} onOpenChange={onOpenChange}>
        <div>content</div>
      </SidebarProvider>,
    );

    expect(() => {
      act(() => {
        window.dispatchEvent(new Event("keydown"));
      });
    }).not.toThrow();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps the existing Cmd/Ctrl+Shift+S shortcut", () => {
    const onOpenChange = jest.fn();

    render(
      <SidebarProvider open={true} onOpenChange={onOpenChange}>
        <div>content</div>
      </SidebarProvider>,
    );

    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not replace the sidebar shortcut with Cmd/Ctrl+B", () => {
    const onOpenChange = jest.fn();

    render(
      <SidebarProvider open={true} onOpenChange={onOpenChange}>
        <div>content</div>
      </SidebarProvider>,
    );

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("uses the default cursor instead of a resize cursor on the sidebar rail", () => {
    const onOpenChange = jest.fn();
    const { container } = render(
      <SidebarProvider open={true} onOpenChange={onOpenChange}>
        <Sidebar>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    );

    const rail = container.querySelector('[data-sidebar="rail"]');

    expect(rail).toHaveClass("cursor-default");
    expect(rail?.className).toContain(
      "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize",
    );
    expect(rail?.className).toContain(
      "[[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
    );

    fireEvent.click(rail!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the expand cursor on the collapsed expand area", () => {
    const { container } = render(
      <SidebarProvider open={false} onOpenChange={jest.fn()}>
        <Sidebar>
          <SidebarContent />
        </Sidebar>
      </SidebarProvider>,
    );

    const expandArea = container.querySelector('[data-sidebar="expand-area"]');

    expect(expandArea).toHaveClass("cursor-e-resize");
  });
});
