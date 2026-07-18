"use client";

import { useState, type DragEvent } from "react";
import {
  Ellipsis,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePinProject, useUnpinProject } from "@/app/hooks/useProjects";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { SidebarProjectIcon } from "./SidebarProjectIcon";
import { SidebarProjectThreads } from "./SidebarProjectThreads";
import {
  hasSidebarChatDragData,
  getSidebarChatDragProjectId,
  SIDEBAR_CHAT_DRAG_TYPE,
} from "./sidebar-chat-drag";

interface SidebarProjectItemProps {
  project: Doc<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewThread: () => void;
  onDropChat: (chatId: string, previousProjectId?: string) => Promise<void>;
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
    event.stopPropagation();
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
    event.stopPropagation();
    setIsDragOver(false);
    const chatId = event.dataTransfer.getData(SIDEBAR_CHAT_DRAG_TYPE);
    const previousProjectId = getSidebarChatDragProjectId(event.dataTransfer);
    if (chatId) void onDropChat(chatId, previousProjectId);
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

  const projectIcon = (
    <SidebarProjectIcon open={open} isLocal={Boolean(project.folder_path)} />
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={`rounded-[10px] ${isDragOver ? "bg-sidebar-accent/40 ring-1 ring-sidebar-ring" : ""}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid={`project-${project._id}-drop-target`}
    >
      <div
        className={`group/project sticky top-9 z-[1] flex h-9 items-center gap-3 bg-sidebar ps-2 pe-0.5 hover:rounded-[10px] hover:bg-sidebar-accent/50 ${isDragOver ? "rounded-[10px] bg-sidebar-accent ring-1 ring-sidebar-ring" : ""}`}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={`${open ? "Collapse" : "Expand"} project ${project.name}`}
          >
            {project.folder_path ? (
              <Tooltip>
                <TooltipTrigger asChild>{projectIcon}</TooltipTrigger>
                <TooltipContent side="right" className="max-w-80 break-all">
                  {project.folder_path}
                </TooltipContent>
              </Tooltip>
            ) : (
              projectIcon
            )}
            <span className="min-w-0 flex-1 truncate" title={project.name}>
              {project.name}
            </span>
          </button>
        </CollapsibleTrigger>

        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex size-8 shrink-0">
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
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={4}
              className="border-0 bg-black px-3 py-1.5 text-xs text-white shadow-md [&_svg]:bg-black [&_svg]:fill-black"
            >
              More options
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" side="bottom" sideOffset={5}>
            {project.folder_path ? (
              <>
                <DropdownMenuLabel className="flex max-w-72 items-center gap-2 font-normal text-muted-foreground">
                  <Laptop className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate" title={project.folder_path}>
                    {project.folder_path}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
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

        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent
            side="top"
            sideOffset={4}
            className="border-0 bg-black px-3 py-1.5 text-xs text-white shadow-md [&_svg]:bg-black [&_svg]:fill-black"
          >
            New task
          </TooltipContent>
        </Tooltip>
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
