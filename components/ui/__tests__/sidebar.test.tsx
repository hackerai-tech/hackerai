import "@testing-library/jest-dom";
import React from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";
import { SidebarProvider } from "../sidebar";

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
});
