"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import type { Id } from "@/convex/_generated/dataModel";
import { useMoveChatToProject } from "@/app/hooks/useProjects";
import { formatTaskUiCopy } from "@/app/utils/task-ui-copy";

export const TASKS_DESTINATION = "tasks" as const;

type MoveDestination = Id<"projects"> | typeof TASKS_DESTINATION;

interface UseMoveChatToProjectActionOptions {
  chatId: string;
  currentProjectId?: Id<"projects">;
}

export function useMoveChatToProjectAction({
  chatId,
  currentProjectId,
}: UseMoveChatToProjectActionOptions) {
  const moveChatToProject = useMoveChatToProject();
  const movingDestinationRef = useRef<MoveDestination | null>(null);
  const [movingDestination, setMovingDestination] =
    useState<MoveDestination | null>(null);

  const startMove = (destination: MoveDestination) => {
    if (movingDestinationRef.current !== null) return false;

    movingDestinationRef.current = destination;
    setMovingDestination(destination);
    return true;
  };

  const finishMove = () => {
    movingDestinationRef.current = null;
    setMovingDestination(null);
  };

  const undoMove = async (projectId: Id<"projects"> | null) => {
    if (!startMove(projectId ?? TASKS_DESTINATION)) return;

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
    } finally {
      finishMove();
    }
  };

  const moveToProject = async (
    projectId: Id<"projects"> | null,
    projectName?: string,
  ): Promise<boolean> => {
    if (!startMove(projectId ?? TASKS_DESTINATION)) return false;

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
      finishMove();
    }
  };

  return { movingDestination, moveToProject };
}
