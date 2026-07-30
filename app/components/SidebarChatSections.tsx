"use client";

import { useId, useState, type ReactNode, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Doc } from "@/convex/_generated/dataModel";
import { usePinChat, useUnpinChat } from "@/app/hooks/useChats";
import SidebarHistory, { type SidebarPaginationStatus } from "./SidebarHistory";
import { SidebarProjects } from "./SidebarProjects";
import {
  dispatchSidebarChatDrop,
  getSidebarChatDragData,
  SIDEBAR_MOUSE_DRAG_DISTANCE,
  SIDEBAR_PINNED_DROP_ID,
  SIDEBAR_TASKS_DROP_ID,
  SIDEBAR_TOUCH_DRAG_DELAY,
  SIDEBAR_TOUCH_DRAG_TOLERANCE,
  type SidebarChatDragData,
  type SidebarChatDropData,
} from "./sidebar-chat-drag";

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
  projectPaginationStatus?: SidebarPaginationStatus;
  loadMoreProjects?: (numItems: number) => void;
  paginationStatus?: SidebarPaginationStatus;
  loadMore?: (numItems: number) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
}

interface CollapsibleChatSectionProps {
  children: ReactNode;
  dropId: string;
  onDrop: SidebarChatDropData["onDrop"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  title: string;
}

const sidebarChatCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);

  return pointerCollisions.length > 0
    ? pointerCollisions
    : rectIntersection(args);
};

function CollapsibleChatSection({
  children,
  dropId,
  onDrop,
  open,
  onOpenChange,
  testId,
  title,
}: CollapsibleChatSectionProps) {
  const contentId = useId();
  const dropData: SidebarChatDropData = {
    type: "sidebar-chat-drop",
    onDrop,
  };
  const { isOver, setNodeRef } = useDroppable({
    id: dropId,
    data: dropData,
  });

  return (
    <section
      ref={setNodeRef}
      className={`relative flex flex-col gap-px rounded-[10px] bg-sidebar ${
        isOver ? "bg-sidebar-accent/40 ring-1 ring-sidebar-ring" : ""
      }`}
      data-testid={testId}
      data-drop-active={isOver ? "true" : undefined}
    >
      <button
        type="button"
        className={`group/chat-section sticky top-0 z-[3] flex h-9 w-full items-center gap-0.5 bg-sidebar py-0.5 ps-2.5 pe-0.5 text-left hover:rounded-[10px] hover:bg-sidebar-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
          isOver
            ? "rounded-[10px] bg-sidebar-accent/70 ring-1 ring-sidebar-ring"
            : ""
        }`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="min-w-0 truncate text-[13px] font-medium leading-[18px] tracking-[-0.091px] text-sidebar-foreground/50">
          {title}
        </span>
        <ChevronRight
          className={`size-3.5 shrink-0 text-sidebar-foreground/45 transition-[transform,opacity] ${
            open
              ? "rotate-90 opacity-0 group-hover/chat-section:opacity-100"
              : "opacity-100"
          }`}
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
  projectPaginationStatus,
  loadMoreProjects,
  paginationStatus,
  loadMore,
  containerRef,
}: SidebarChatSectionsProps) {
  const [isPinnedOpen, setIsPinnedOpen] = useState(true);
  const [isTasksOpen, setIsTasksOpen] = useState(true);
  const [activeTask, setActiveTask] = useState<SidebarChatDragData>();
  const pinChat = usePinChat();
  const unpinChat = useUnpinChat();
  const pinnedChats = chats.filter((chat) => chat.pinned_at != null);
  const taskChats = chats.filter((chat) => chat.pinned_at == null);
  const pinnedProjects = projects?.filter(
    (project) => project.pinned_at != null,
  );
  const unpinnedProjects = projects?.filter(
    (project) => project.pinned_at == null,
  );
  const hasPinnedItems =
    pinnedChats.length > 0 || (pinnedProjects?.length ?? 0) > 0;

  const handlePinnedDrop = async (chat: SidebarChatDragData) => {
    if (chat.isPinned) return;

    try {
      await pinChat({ chatId: chat.chatId });
      toast.success("Task pinned");
    } catch (error) {
      console.error("Failed to pin dropped task:", error);
      toast.error("Failed to pin task");
    }
  };

  const handleTasksDrop = async (chat: SidebarChatDragData) => {
    if (!chat.isPinned) return;

    try {
      await unpinChat({ chatId: chat.chatId });
      toast.success("Task unpinned");
    } catch (error) {
      console.error("Failed to unpin dropped task:", error);
      toast.error("Failed to unpin task");
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTask(getSidebarChatDragData(event.active.data.current));
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    setActiveTask(undefined);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(undefined);
    dispatchSidebarChatDrop(
      event.active.data.current,
      event.over?.data.current,
    );
  };

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: SIDEBAR_MOUSE_DRAG_DISTANCE },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: SIDEBAR_TOUCH_DRAG_DELAY,
        tolerance: SIDEBAR_TOUCH_DRAG_TOLERANCE,
      },
    }),
    useSensor(KeyboardSensor),
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarChatCollisionDetection}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <div
        className="flex min-h-full flex-col gap-3 pb-3"
        data-testid="sidebar-chat-sections"
      >
        {hasPinnedItems || activeTask ? (
          <CollapsibleChatSection
            title="Pinned"
            dropId={SIDEBAR_PINNED_DROP_ID}
            onDrop={handlePinnedDrop}
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
            <SidebarProjects projects={pinnedProjects} variant="pinned-list" />
          </CollapsibleChatSection>
        ) : null}

        <SidebarProjects
          projects={unpinnedProjects}
          paginationStatus={projectPaginationStatus}
          loadMore={loadMoreProjects}
        />

        <CollapsibleChatSection
          title="Tasks"
          dropId={SIDEBAR_TASKS_DROP_ID}
          onDrop={handleTasksDrop}
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
      <DragOverlay>
        {activeTask ? (
          <div className="max-w-64 truncate rounded-lg border border-sidebar-border bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-foreground shadow-lg">
            {activeTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
