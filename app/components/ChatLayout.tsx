"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { useCompactTaskSidebar } from "@/hooks/use-workspace-layout";
import { useGlobalState } from "../contexts/GlobalState";
import { useChats } from "../hooks/useChats";
import { useProjects } from "../hooks/useProjects";
import { SidebarProvider } from "@/components/ui/sidebar";
import MainSidebar from "./Sidebar";
import {
  loadSettingsDialog,
  onOpenSettingsDialog,
} from "@/lib/utils/settings-dialog";

const SettingsDialog = dynamic(
  () => loadSettingsDialog().then((module) => module.SettingsDialog),
  {
    ssr: false,
    loading: () => null,
  },
);

/**
 * Shared layout for chat routes: Chat Sidebar (left) + main content slot.
 * Stays mounted across / and /c/[id] navigation so the sidebar does not re-render.
 * Does NOT include the Computer Sidebar (right); that remains in ChatContent.
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const compactTaskSidebar = useCompactTaskSidebar();
  const { chatSidebarOpen, setChatSidebarOpen, sidebarOpen } = useGlobalState();
  const panelRef = useRef<HTMLDivElement>(null);
  const [compactSidebarOverlayOpen, setCompactSidebarOverlayOpen] =
    useState(false);
  // Keep list subscriptions in the layout so mobile overlay remounts do not refetch.
  const chatListData = useChats();
  const projectListData = useProjects();
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Settings dialog — local state, opened via custom event from anywhere
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [hasOpenedSettingsDialog, setHasOpenedSettingsDialog] = useState(false);
  const [settingsDialogTab, setSettingsDialogTab] = useState<string | null>(
    null,
  );

  const handleOpenSettings = useCallback((tab?: string) => {
    setHasOpenedSettingsDialog(true);
    setSettingsDialogTab(null);
    // Force a fresh state change even if the same tab is requested again
    queueMicrotask(() => {
      setSettingsDialogTab(tab ?? null);
      setSettingsDialogOpen(true);
    });
  }, []);

  useEffect(
    () => onOpenSettingsDialog(handleOpenSettings),
    [handleOpenSettings],
  );

  const forceTaskSidebarRail = Boolean(
    isMobile === false && sidebarOpen && compactTaskSidebar,
  );
  const taskSidebarOverlayOpen =
    isMobile === true
      ? chatSidebarOpen
      : forceTaskSidebarRail && compactSidebarOverlayOpen;
  const closeTaskSidebarOverlay = useCallback(() => {
    if (isMobile) {
      setChatSidebarOpen(false);
      return;
    }
    setCompactSidebarOverlayOpen(false);
  }, [isMobile, setChatSidebarOpen]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setCompactSidebarOverlayOpen(false);
    });
    return () => {
      cancelled = true;
    };
  }, [forceTaskSidebarRail, pathname]);

  // Escape key handler and focus trap for mobile and compact desktop overlays.
  useEffect(() => {
    if (!taskSidebarOverlayOpen) return;

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
        closeTaskSidebarOverlay();
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
  }, [closeTaskSidebarOverlay, taskSidebarOverlayOpen]);

  const handleDesktopSidebarOpenChange = useCallback(
    (open: boolean) => {
      if (forceTaskSidebarRail) {
        setCompactSidebarOverlayOpen(open);
        return;
      }
      setChatSidebarOpen(open);
    },
    [forceTaskSidebarRail, setChatSidebarOpen],
  );

  const desktopSidebarExpanded = chatSidebarOpen && !forceTaskSidebarRail;

  return (
    <div className="flex min-h-0 flex-1 w-full overflow-hidden">
      {/* Chat Sidebar - Desktop: only mount once isMobile is resolved to avoid flash on mobile */}
      {isMobile === false && (
        <div
          data-testid="sidebar"
          data-layout={forceTaskSidebarRail ? "compact-rail" : "standard"}
          className={`relative z-10 min-w-0 shrink-0 overflow-hidden bg-sidebar transition-all duration-300 ${
            desktopSidebarExpanded ? "w-[300px]" : "w-12"
          }`}
        >
          <SidebarProvider
            open={desktopSidebarExpanded}
            onOpenChange={handleDesktopSidebarOpenChange}
            persistOpenState={!forceTaskSidebarRail}
            defaultOpen={true}
          >
            <MainSidebar
              chatListData={chatListData}
              projectListData={projectListData}
            />
          </SidebarProvider>
        </div>
      )}

      {/* Main content slot - pages render here */}
      <div className="flex min-h-0 flex-1 min-w-0 flex-col relative">
        {/* Billing status is checked on demand in Account settings. Keep the
            global layout free of billing/Stripe status requests. */}
        {children}
      </div>

      {/* Overlay task sidebar for mobile and constrained desktop workspaces. */}
      {taskSidebarOverlayOpen && (
        <div
          className="fixed inset-0 z-[55] flex bg-black/50"
          onClick={closeTaskSidebarOverlay}
          data-testid="task-sidebar-overlay"
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Task sidebar"
            tabIndex={-1}
            className={`h-full bg-background shadow-lg transform transition-transform duration-300 ease-in-out ${
              isMobile
                ? "w-full max-w-80"
                : "w-[300px] max-w-[calc(100vw-2rem)]"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <MainSidebar
              isMobileOverlay={true}
              onClose={closeTaskSidebarOverlay}
              chatListData={chatListData}
              projectListData={projectListData}
            />
          </div>
        </div>
      )}
      {/* Load settings on first use, then keep it mounted for close animations. */}
      {hasOpenedSettingsDialog && (
        <SettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          initialTab={settingsDialogTab}
        />
      )}
    </div>
  );
}
