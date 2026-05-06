import { tool } from "ai";
import type { ToolContext, Todo } from "@/types";
import { TODO_WRITE_DESCRIPTION, TODO_WRITE_INPUT_SCHEMA } from "./schemas";

export const createTodoWrite = (context: ToolContext) => {
  const { todoManager, assistantMessageId } = context;

  return tool({
    description: TODO_WRITE_DESCRIPTION,
    inputSchema: TODO_WRITE_INPUT_SCHEMA,
    execute: async ({
      merge,
      todos,
    }: {
      merge: boolean;
      todos: Array<{
        id: string;
        content?: string;
        status: Todo["status"];
      }>;
    }) => {
      try {
        // Runtime validation for non-merge operations
        if (!merge) {
          for (let i = 0; i < todos.length; i++) {
            const todo = todos[i];
            if (!todo.content || todo.content.trim() === "") {
              throw new Error(
                `Todo at index ${i} is missing required content field`,
              );
            }
          }
        }

        // If incoming payload looks like partial updates (missing content fields), switch to merge to avoid replacing the whole plan.
        const shouldMerge =
          merge ||
          todos.some((t) => t.content === undefined || t.content === null);

        // Update backend state first (TodoManager handles deduplication)
        const updatedTodos = todoManager.setTodos(
          // When creating a plan (shouldMerge=false), stamp todos with assistantMessageId
          shouldMerge || !assistantMessageId
            ? todos
            : todos.map((t) => ({ ...t, sourceMessageId: assistantMessageId })),
          shouldMerge,
        );

        // Get current stats from the manager
        const stats = todoManager.getStats();
        const action = shouldMerge ? "updated" : "created";

        const counts = {
          completed: stats.done, // Use 'done' which includes both completed and cancelled
          total: stats.total,
        };

        // Include current todos in response for visibility
        const currentTodos = updatedTodos.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status,
          sourceMessageId: t.sourceMessageId,
        }));

        return {
          result: `Successfully ${action} to-dos. Make sure to follow and update your to-do list as you make progress. Cancel and add new to-do tasks as needed when the user makes a correction or follow-up request.${
            stats.inProgress === 0
              ? " No to-dos are marked in-progress, make sure to mark them before starting the next."
              : ""
          }`,
          counts,
          currentTodos,
        };
      } catch (error) {
        return {
          error: `Failed to manage todos: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
