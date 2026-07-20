"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Id } from "@/convex/_generated/dataModel";
import { useMoveChatToProject } from "@/app/hooks/useProjects";
import { formatTaskUiCopy } from "@/app/utils/task-ui-copy";

export const TASKS_DESTINATION = "tasks" as const;

interface UseMoveChatToProjectActionOptions {
  chatId: string;
  currentProjectId?: Id<"projects">;
}

export function useMoveChatToProjectAction({
  chatId,
  currentProjectId,
}: UseMoveChatToProjectActionOptions) {
  const moveChatToProject = useMoveChatToProject();
  const [movingDestination, setMovingDestination] = useState<
    Id<"projects"> | typeof TASKS_DESTINATION | null
  >(null);

  const undoMove = async (projectId: Id<"projects"> | null) => {
    try {
      await moveChatToProject({ chatId, projectId });
      toast.success("Move undone");
    } catch (error) {
      console.error("Failed to undo task move:", error);
      toast.error("Failed to undo move", {
        description:
          error instanceof Error
            ? formatTaskUiCopy(error.message)
            : "Please try again.",
      });
    }
  };

  const moveToProject = async (
    projectId: Id<"projects"> | null,
    projectName?: string,
  ): Promise<boolean> => {
    if (movingDestination !== null) return false;

    setMovingDestination(projectId ?? TASKS_DESTINATION);
    try {
      const moved = await moveChatToProject({ chatId, projectId });
      if (moved) {
        toast.success(
          projectId === null
            ? "Removed from project"
            : `Moved to ${projectName}`,
          {
            action: {
              label: "Undo",
              onClick: () => void undoMove(currentProjectId ?? null),
            },
          },
        );
      } else {
        toast.info(
          projectId === null ? "Already in Tasks" : `Already in ${projectName}`,
        );
      }
      return true;
    } catch (error) {
      console.error("Failed to move chat to project:", error);
      toast.error("Failed to move task", {
        description:
          error instanceof Error
            ? formatTaskUiCopy(error.message)
            : "Please try again.",
      });
      return false;
    } finally {
      setMovingDestination(null);
    }
  };

  return { movingDestination, moveToProject };
}
