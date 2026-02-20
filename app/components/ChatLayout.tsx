"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGlobalState } from "../contexts/GlobalState";
import { useChats } from "../hooks/useChats";
import { SidebarProvider } from "@/components/ui/sidebar";
import MainSidebar from "./Sidebar";
import { SettingsDialog } from "./SettingsDialog";
import { onOpenSettingsDialog } from "@/lib/utils/settings-dialog";

/**
 * Shared layout for chat routes: Chat Sidebar (left) + main content slot.
 * Stays mounted across / and /c/[id] navigation so the sidebar does not re-render.
 * Does NOT include the Computer Sidebar (right); that remains in ChatContent.
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const { chatSidebarOpen, setChatSidebarOpen } = useGlobalState();
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep chat list subscription in layout so it doesn't refetch when sidebar opens/closes
  const chatListData = useChats();
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Settings dialog — local state, opened via custom event from anywhere
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsDialogTab, setSettingsDialogTab] = useState<string | null>(
    null,
  );

  const handleOpenSettings = useCallback((tab?: string) => {
    setSettingsDialogTab(tab ?? null);
    setSettingsDialogOpen(true);
  }, []);

  useEffect(
    () => onOpenSettingsDialog(handleOpenSettings),
    [handleOpenSettings],
  );

  // Escape key handler and focus trap for mobile overlay
  useEffect(() => {
    if (!isMobile || !chatSidebarOpen) return;

    // Store the previously focused element
    previousActiveElementRef.current = document.activeElement as HTMLElement;

    // Focus trap: Get all focusable elements within the panel
    const getFocusableElements = (container: HTMLElement): HTMLElement[] => {
      const selector = [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
      ].join(", ");
      return Array.from(container.querySelectorAll<HTMLElement>(selector));
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChatSidebarOpen(false);
        return;
      }

      if (e.key !== "Tab" || !panelRef.current) return;

      const focusableElements = getFocusableElements(panelRef.current);
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if focus is on first element, move to last
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: if focus is on last element, move to first
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    // Focus the first focusable element when overlay opens
    const focusFirstElement = () => {
      if (panelRef.current) {
        const focusableElements = getFocusableElements(panelRef.current);
        if (focusableElements.length > 0) {
          focusableElements[0].focus();
        } else {
          // If no focusable elements, focus the panel itself
          panelRef.current.focus();
        }
      }
    };

    // Small delay to ensure panel is rendered
    const timeoutId = setTimeout(focusFirstElement, 0);

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to previously focused element
      if (previousActiveElementRef.current) {
        previousActiveElementRef.current.focus();
      }
    };
  }, [isMobile, chatSidebarOpen, setChatSidebarOpen]);

  return (
    <div className="flex min-h-0 flex-1 w-full overflow-hidden">
      {/* Chat Sidebar - Desktop: only mount once isMobile is resolved to avoid flash on mobile */}
      {isMobile === false && (
        <div
          data-testid="sidebar"
          className={`relative z-10 min-w-0 shrink-0 overflow-hidden bg-sidebar transition-all duration-300 ${
            chatSidebarOpen ? "w-72" : "w-12"
          }`}
        >
          <SidebarProvider
            open={chatSidebarOpen}
            onOpenChange={setChatSidebarOpen}
            defaultOpen={true}
          >
            <MainSidebar chatListData={chatListData} />
          </SidebarProvider>
        </div>
      )}

      {/* Main content slot - pages render here */}
      <div className="flex min-h-0 flex-1 min-w-0 flex-col relative">
        {children}
      </div>

      {/* Overlay Chat Sidebar - Mobile: only when resolved to mobile */}
      {isMobile === true && chatSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 flex"
          onClick={() => setChatSidebarOpen(false)}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className="w-full max-w-80 h-full bg-background shadow-lg transform transition-transform duration-300 ease-in-out"
            onClick={(e) => e.stopPropagation()}
          >
            <MainSidebar isMobileOverlay={true} chatListData={chatListData} />
          </div>
        </div>
      )}
      {/* Settings Dialog - rendered here so it's always mounted (including mobile) */}
      <SettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
        initialTab={settingsDialogTab}
      />
    </div>
  );
}
