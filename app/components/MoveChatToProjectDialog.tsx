"use client";

import { useState } from "react";
import { Folder, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
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
import { useMoveChatToProject, useProjects } from "@/app/hooks/useProjects";

interface MoveChatToProjectDialogProps {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MoveChatToProjectDialog({
  chatId,
  open,
  onOpenChange,
}: MoveChatToProjectDialogProps) {
  const projects = useProjects();
  const moveChatToProject = useMoveChatToProject();
  const [movingToProjectId, setMovingToProjectId] =
    useState<Id<"projects"> | null>(null);

  const handleMove = async (projectId: Id<"projects">, projectName: string) => {
    if (movingToProjectId) return;

    setMovingToProjectId(projectId);
    try {
      const moved = await moveChatToProject({ chatId, projectId });
      onOpenChange(false);
      if (moved) {
        toast.success(`Moved to ${projectName}`);
      } else {
        toast.info(`Already in ${projectName}`);
      }
    } catch (error) {
      console.error("Failed to move chat to project:", error);
      toast.error("Failed to move chat", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setMovingToProjectId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to project</DialogTitle>
          <DialogDescription>
            Choose the project where this chat should appear.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-1 overflow-y-auto py-2">
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
                disabled={movingToProjectId !== null}
              >
                {movingToProjectId === project._id ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin" />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="truncate">{project.name}</span>
              </Button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={movingToProjectId !== null}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
