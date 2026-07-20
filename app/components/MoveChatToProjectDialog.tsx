"use client";

import { Folder, FolderMinus, LoaderCircle } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProjects } from "@/app/hooks/useProjects";
import {
  TASKS_DESTINATION,
  useMoveChatToProjectAction,
} from "@/app/hooks/useMoveChatToProjectAction";

interface MoveChatToProjectDialogProps {
  chatId: string;
  currentProjectId?: Id<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MoveChatToProjectDialog({
  chatId,
  currentProjectId,
  open,
  onOpenChange,
}: MoveChatToProjectDialogProps) {
  const projectListData = useProjects();
  const projects = projectListData.results;
  const { movingDestination, moveToProject } = useMoveChatToProjectAction({
    chatId,
    currentProjectId,
  });

  const handleMove = async (
    projectId: Id<"projects"> | null,
    projectName?: string,
  ) => {
    const moveFinished = await moveToProject(projectId, projectName);
    if (moveFinished) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (movingDestination !== null) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={movingDestination === null}
      >
        <DialogHeader>
          <DialogTitle>Move to project</DialogTitle>
          <DialogDescription>
            Choose the project where this task should appear.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-1 overflow-y-auto py-2">
          {currentProjectId ? (
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full justify-start gap-2 px-3"
              onClick={() => void handleMove(null)}
              disabled={movingDestination !== null}
            >
              {movingDestination === TASKS_DESTINATION ? (
                <LoaderCircle
                  className="size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <FolderMinus className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span>Remove from project</span>
            </Button>
          ) : null}

          {projects === undefined ? (
            <div
              className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              Loading projects…
            </div>
          ) : projects.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Create a project from the sidebar first.
            </p>
          ) : (
            projects.map((project) => (
              <Button
                key={project._id}
                type="button"
                variant="ghost"
                className="h-10 w-full justify-start gap-2 px-3"
                onClick={() => void handleMove(project._id, project.name)}
                disabled={movingDestination !== null}
              >
                {movingDestination === project._id ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin" />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="truncate">{project.name}</span>
              </Button>
            ))
          )}

          {projectListData.status === "LoadingMore" ? (
            <div
              className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              Loading more projects…
            </div>
          ) : null}

          {projectListData.status === "CanLoadMore" ? (
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full"
              onClick={() => projectListData.loadMore(10)}
              disabled={movingDestination !== null}
            >
              Show more projects
            </Button>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={movingDestination !== null}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
