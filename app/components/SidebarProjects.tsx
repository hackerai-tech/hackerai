"use client";

import { useState } from "react";
import { ChevronRight, ListChevronsDownUp, Plus } from "lucide-react";
import { toast } from "sonner";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useMoveChatToProject } from "@/app/hooks/useProjects";
import { useStartNewChat } from "@/app/hooks/useStartNewChat";
import { formatTaskUiCopy } from "@/app/utils/task-ui-copy";
import { ProjectCreateDialog } from "./ProjectCreateDialog";
import { SidebarProjectItem } from "./SidebarProjectItem";

interface SidebarProjectsProps {
  projects: Doc<"projects">[] | undefined;
}

export function SidebarProjects({ projects }: SidebarProjectsProps) {
  const { desktopBridgeActive } = useGlobalState();
  const moveChatToProject = useMoveChatToProject();
  const startNewChat = useStartNewChat();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSectionOpen, setIsSectionOpen] = useState(true);
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(
    () => new Set(),
  );

  const projectIds = projects?.map((project) => project._id) ?? [];
  const areAllProjectsOpen =
    projectIds.length > 0 &&
    projectIds.every((projectId) => openProjectIds.has(projectId));

  const setProjectOpen = (projectId: string, open: boolean) => {
    setOpenProjectIds((current) => {
      const next = new Set(current);
      if (open) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };

  const handleCreated = (projectId: Id<"projects">) => {
    setIsSectionOpen(true);
    setProjectOpen(projectId, true);
  };

  const toggleAllProjects = () => {
    setIsSectionOpen(true);
    setOpenProjectIds(areAllProjectsOpen ? new Set() : new Set(projectIds));
  };

  const handleNewThread = (project: Doc<"projects">) => {
    if (project.folder_path && !desktopBridgeActive) {
      toast.error("Connect HackerAI Desktop", {
        description: `“${project.name}” is linked to a local folder. Open HackerAI Desktop and wait for it to connect before starting a thread.`,
      });
      return;
    }

    startNewChat({
      projectId: project._id,
      useDesktop: Boolean(project.folder_path),
    });
  };

  const handleDropChat = async (project: Doc<"projects">, chatId: string) => {
    setProjectOpen(project._id, true);
    try {
      const moved = await moveChatToProject({
        chatId,
        projectId: project._id,
      });
      if (moved) toast.success(`Moved to ${project.name}`);
    } catch (error) {
      console.error("Failed to move chat to project:", error);
      toast.error("Failed to move task", {
        description:
          error instanceof Error
            ? formatTaskUiCopy(error.message)
            : "Please try again.",
      });
    }
  };

  return (
    <section
      aria-labelledby="sidebar-projects-heading"
      className="relative flex flex-col gap-px bg-sidebar pb-2"
    >
      <div className="group/projects-header sticky top-0 z-[3] flex h-9 items-center gap-3 bg-sidebar py-0.5 ps-2.5 pe-0.5 hover:rounded-[10px] hover:bg-sidebar-accent/40">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={() => setIsSectionOpen((current) => !current)}
          aria-expanded={isSectionOpen}
          aria-controls="sidebar-project-list"
        >
          <span
            id="sidebar-projects-heading"
            className="min-w-0 truncate text-[13px] font-medium leading-[18px] tracking-[-0.091px] text-sidebar-foreground/50"
          >
            Projects
          </span>
          <ChevronRight
            className={`size-3.5 shrink-0 text-sidebar-foreground/45 opacity-0 transition-[transform,opacity] group-hover/projects-header:opacity-100 ${isSectionOpen ? "rotate-90" : ""}`}
            data-testid="projects-section-chevron"
            aria-hidden="true"
          />
        </button>

        <div className="flex items-center">
          {projectIds.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg text-sidebar-foreground/45 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onClick={toggleAllProjects}
              aria-label={
                areAllProjectsOpen
                  ? "Collapse all projects"
                  : "Expand all projects"
              }
            >
              <ListChevronsDownUp className="size-[18px]" />
            </Button>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg text-sidebar-foreground/45 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setIsCreateOpen(true)}
            aria-label="Create project"
          >
            <Plus className="size-[18px]" />
          </Button>
        </div>
      </div>

      {isSectionOpen ? (
        <div id="sidebar-project-list" className="flex flex-col gap-px">
          {projects === undefined ? (
            <div className="px-2 py-0.5" aria-label="Loading projects">
              <div className="h-9 animate-pulse rounded-[10px] bg-sidebar-accent/50" />
            </div>
          ) : (
            projects.map((project) => (
              <SidebarProjectItem
                key={project._id}
                project={project}
                open={openProjectIds.has(project._id)}
                onOpenChange={(open) => setProjectOpen(project._id, open)}
                onNewThread={() => handleNewThread(project)}
                onDropChat={(chatId) => handleDropChat(project, chatId)}
              />
            ))
          )}
        </div>
      ) : null}

      <ProjectCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onCreated={handleCreated}
      />
    </section>
  );
}
