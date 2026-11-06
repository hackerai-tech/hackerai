"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useShortcutPlatform } from "@/hooks/use-shortcut-platform";
import {
  SHORTCUTS,
  OPEN_SHORTCUTS_EVENT,
  hasOpenShortcutOverlay,
  isShortcutTargetBlocked,
  matchesShortcut,
  shortcutKeys,
  spokenShortcutKey,
  type ShortcutId,
} from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-mobile";
import { MessageSearchDialog } from "./MessageSearchDialog";
import { useStartNewChat } from "../hooks/useStartNewChat";

const groups: { label: string; shortcuts: ShortcutId[] }[] = [
  {
    label: "General",
    shortcuts: ["newTask", "search", "sidebar", "shortcuts"],
  },
  { label: "In the composer", shortcuts: ["send", "newline", "stop"] },
];

export function KeyboardShortcuts({
  onToggleMobileSidebar,
}: {
  onToggleMobileSidebar?: () => void;
}) {
  const isMobile = useIsMobile();
  const sectionId = useId();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const isMac = useShortcutPlatform();
  const startNewChat = useStartNewChat();
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = () => {
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setOpen(true);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShortcutTargetBlocked(event)) return;
      if (
        matchesShortcut(event, "shortcuts", isMac) &&
        (open || !hasOpenShortcutOverlay())
      ) {
        event.preventDefault();
        if (open) setOpen(false);
        else show();
        return;
      }
      // On narrow screens the sidebar (and its search listener) is unmounted.
      if (
        isMobile &&
        matchesShortcut(event, "search", isMac) &&
        !hasOpenShortcutOverlay()
      ) {
        event.preventDefault();
        setMobileSearchOpen(true);
      }
      if (
        isMobile &&
        onToggleMobileSidebar &&
        matchesShortcut(event, "sidebar", isMac) &&
        !hasOpenShortcutOverlay()
      ) {
        event.preventDefault();
        onToggleMobileSidebar();
      }
      if (
        matchesShortcut(event, "newTask", isMac) &&
        !hasOpenShortcutOverlay()
      ) {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener(OPEN_SHORTCUTS_EVENT, show);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, show);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMac, open, startNewChat, isMobile, onToggleMobileSidebar]);

  return (
    <>
      {(isMobile || mobileSearchOpen) && (
        <MessageSearchDialog
          isOpen={mobileSearchOpen}
          onClose={() => setMobileSearchOpen(false)}
        />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (
              previousFocus.current?.isConnected &&
              previousFocus.current !== document.body
            )
              previousFocus.current.focus();
            else
              document
                .querySelector<HTMLButtonElement>(
                  '[data-testid="user-menu-button"], [data-testid="user-menu-button-collapsed"]',
                )
                ?.focus();
          }}
        >
          <DialogHeader className="border-b px-6 py-5 text-left">
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Move faster in HackerAI with your keyboard.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 px-6 py-5">
            {groups.map((group, index) => (
              <section
                key={group.label}
                aria-labelledby={`${sectionId}-${index}`}
              >
                <h3
                  id={`${sectionId}-${index}`}
                  className="mb-2 text-xs font-medium text-muted-foreground"
                >
                  {group.label}
                </h3>
                <dl className="divide-y divide-border/60">
                  {group.shortcuts.map((id) => (
                    <div
                      key={id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 text-sm"
                    >
                      <dt>{SHORTCUTS[id].label}</dt>
                      <dd className="flex shrink-0 gap-1">
                        {shortcutKeys(id, isMac).map((key) => (
                          <kbd
                            key={key}
                            className={`inline-flex h-6 min-w-6 items-center justify-center rounded-md border bg-muted/60 px-1.5 font-sans text-foreground/80 ${key === "." || key === "/" ? "text-sm font-medium" : "text-xs"}`}
                          >
                            <span aria-hidden="true">{key}</span>
                            <span className="sr-only">
                              {spokenShortcutKey(key)}
                            </span>
                          </kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
