"use client";

import { useState, type DragEvent } from "react";
import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Laptop,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePinProject, useUnpinProject } from "@/app/hooks/useProjects";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { SidebarProjectThreads } from "./SidebarProjectThreads";
import {
  hasSidebarChatDragData,
  SIDEBAR_CHAT_DRAG_TYPE,
} from "./sidebar-chat-drag";

interface SidebarProjectItemProps {
  project: Doc<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewThread: () => void;
  onDropChat: (chatId: string) => Promise<void>;
}

export function SidebarProjectItem({
  project,
  open,
  onOpenChange,
  onNewThread,
  onDropChat,
}: SidebarProjectItemProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isPinning, setIsPinning] = useState(false);
  const pinProject = usePinProject();
  const unpinProject = useUnpinProject();

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasSidebarChatDragData(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasSidebarChatDragData(event.dataTransfer)) return;
    event.preventDefault();
    setIsDragOver(false);
    const chatId = event.dataTransfer.getData(SIDEBAR_CHAT_DRAG_TYPE);
    if (chatId) void onDropChat(chatId);
  };

  const handleTogglePinned = async () => {
    if (isPinning) return;
    setIsPinning(true);
    try {
      if (project.pinned_at !== undefined) {
        await unpinProject({ projectId: project._id });
      } else {
        await pinProject({ projectId: project._id });
      }
    } catch (error) {
      console.error("Failed to update project pin:", error);
      toast.error(
        project.pinned_at !== undefined
          ? "Failed to unpin project"
          : "Failed to pin project",
      );
    } finally {
      setIsPinning(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        className={`group/project sticky top-9 z-[1] flex h-9 items-center gap-3 bg-sidebar ps-2 pe-0.5 hover:rounded-[10px] hover:bg-sidebar-accent/50 ${isDragOver ? "rounded-[10px] bg-sidebar-accent ring-1 ring-sidebar-ring" : ""}`}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid={`project-${project._id}-drop-target`}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={`${open ? "Collapse" : "Expand"} project ${project.name}`}
          >
            <span className="relative flex size-5 shrink-0 items-center justify-center">
              {open ? (
                <FolderOpen
                  className="absolute size-4 transition-opacity group-hover/project:opacity-0 touch-device:!opacity-100"
                  data-testid="project-folder-open"
                  aria-hidden="true"
                />
              ) : (
                <Folder
                  className="absolute size-4 transition-opacity group-hover/project:opacity-0 touch-device:!opacity-100"
                  data-testid="project-folder-closed"
                  aria-hidden="true"
                />
              )}
              <ChevronRight
                className={`absolute size-[18px] text-sidebar-foreground/45 opacity-0 transition-[transform,opacity] duration-200 group-hover/project:opacity-100 touch-device:!opacity-0 ${open ? "rotate-90" : ""}`}
                data-testid="project-chevron"
                aria-hidden="true"
              />
            </span>
            <span className="min-w-0 flex-1 truncate" title={project.name}>
              {project.name}
            </span>
            {project.folder_path ? (
              <Laptop
                className="size-3.5 shrink-0 text-sidebar-foreground/35"
                aria-hidden="true"
              />
            ) : null}
          </button>
        </CollapsibleTrigger>

        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-lg text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 touch-device:!opacity-100"
              aria-label={`Project options for ${project.name}`}
            >
              <Ellipsis className="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" sideOffset={5}>
            <DropdownMenuItem
              disabled={isPinning}
              onSelect={() => void handleTogglePinned()}
            >
              {project.pinned_at !== undefined ? (
                <PinOff className="mr-2 size-4" />
              ) : (
                <Pin className="mr-2 size-4" />
              )}
              {project.pinned_at !== undefined ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setIsEditOpen(true)}>
              <Pencil className="mr-2 size-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => setIsDeleteOpen(true)}
            >
              <Trash2 className="mr-2 size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-lg text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100 touch-device:!opacity-100"
          onClick={onNewThread}
          aria-label={`New task in ${project.name}`}
        >
          <SquarePen className="size-[18px]" />
        </Button>
      </div>

      <CollapsibleContent>
        {open ? <SidebarProjectThreads project={project} /> : null}
      </CollapsibleContent>

      {isEditOpen ? (
        <ProjectEditDialog
          project={project}
          open
          onOpenChange={setIsEditOpen}
        />
      ) : null}
      {isDeleteOpen ? (
        <ProjectDeleteDialog
          project={project}
          open
          onOpenChange={setIsDeleteOpen}
        />
      ) : null}
    </Collapsible>
  );
}
