"use client";

import { useId, useState, type ReactNode, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import SidebarHistory, { type SidebarPaginationStatus } from "./SidebarHistory";
import { SidebarProjects } from "./SidebarProjects";

interface SidebarChat {
  _id: string;
  id: string;
  title: string;
  pinned_at?: number;
  [key: string]: unknown;
}

interface SidebarChatSectionsProps {
  chats: SidebarChat[];
  projects: Doc<"projects">[] | undefined;
  paginationStatus?: SidebarPaginationStatus;
  loadMore?: (numItems: number) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
}

interface CollapsibleChatSectionProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  title: string;
}

function CollapsibleChatSection({
  children,
  open,
  onOpenChange,
  testId,
  title,
}: CollapsibleChatSectionProps) {
  const contentId = useId();

  return (
    <section
      className="relative flex flex-col gap-px bg-sidebar"
      data-testid={testId}
    >
      <button
        type="button"
        className="group/chat-section sticky top-0 z-[3] flex h-9 w-full items-center gap-0.5 bg-sidebar py-0.5 ps-2.5 pe-0.5 text-left hover:rounded-[10px] hover:bg-sidebar-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="min-w-0 truncate text-[13px] font-medium leading-[18px] tracking-[-0.091px] text-sidebar-foreground/50">
          {title}
        </span>
        <ChevronRight
          className={`size-3.5 shrink-0 text-sidebar-foreground/45 opacity-0 transition-[transform,opacity] group-hover/chat-section:opacity-100 ${open ? "rotate-90" : ""}`}
          data-testid={`${testId}-chevron`}
          aria-hidden="true"
        />
      </button>

      {open ? <div id={contentId}>{children}</div> : null}
    </section>
  );
}

export function SidebarChatSections({
  chats,
  projects,
  paginationStatus,
  loadMore,
  containerRef,
}: SidebarChatSectionsProps) {
  const [isPinnedOpen, setIsPinnedOpen] = useState(true);
  const [isTasksOpen, setIsTasksOpen] = useState(true);
  const pinnedChats = chats.filter((chat) => chat.pinned_at != null);
  const taskChats = chats.filter((chat) => chat.pinned_at == null);

  return (
    <div
      className="flex min-h-full flex-col gap-3 pb-3"
      data-testid="sidebar-chat-sections"
    >
      {pinnedChats.length > 0 ? (
        <CollapsibleChatSection
          title="Pinned"
          open={isPinnedOpen}
          onOpenChange={setIsPinnedOpen}
          testId="sidebar-pinned-section"
        >
          <SidebarHistory
            chats={pinnedChats}
            containerRef={containerRef}
            showEmptyState={false}
            testId="sidebar-pinned-chat-list"
          />
        </CollapsibleChatSection>
      ) : null}

      <SidebarProjects projects={projects} />

      <CollapsibleChatSection
        title="Tasks"
        open={isTasksOpen}
        onOpenChange={setIsTasksOpen}
        testId="sidebar-tasks-section"
      >
        <SidebarHistory
          chats={taskChats}
          paginationStatus={paginationStatus}
          loadMore={loadMore}
          containerRef={containerRef}
          showEmptyState={
            projects !== undefined &&
            projects.length === 0 &&
            pinnedChats.length === 0
          }
        />
      </CollapsibleChatSection>
    </div>
  );
}
