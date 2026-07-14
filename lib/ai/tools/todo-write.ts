import { tool } from "ai";
import type { ToolContext, Todo } from "@/types";
import { todoWriteTool } from "./schemas";

export const createTodoWrite = (context: ToolContext) => {
  const { todoManager, assistantMessageId } = context;

  return tool({
    ...todoWriteTool,
    execute: async ({
      merge,
      todos,
    }: {
      merge: boolean;
      todos: Array<{
        id: string;
        content?: string;
        status?: Todo["status"];
      }>;
    }) => {
      try {
        // If incoming payload looks like partial updates (missing content fields), switch to merge to avoid replacing the whole plan.
        const shouldMerge =
          merge ||
          todos.some(
            (t) =>
              t.content === undefined ||
              t.content === null ||
              t.status === undefined ||
              t.status === null,
          );

        const existingTodoIds = new Set(
          todoManager.getAllTodos().map((todo) => todo.id),
        );
        const todosWithSourceMessageId: Array<Partial<Todo> & { id: string }> =
          assistantMessageId
            ? todos.map((todo) => {
                const isNewCompleteMergeTodo =
                  shouldMerge &&
                  !existingTodoIds.has(todo.id) &&
                  typeof todo.content === "string" &&
                  todo.content.trim() !== "" &&
                  todo.status !== undefined;
                const shouldStamp = !shouldMerge || isNewCompleteMergeTodo;

                return shouldStamp
                  ? { ...todo, sourceMessageId: assistantMessageId }
                  : todo;
              })
            : todos;

        // Update backend state first (TodoManager handles deduplication)
        const updatedTodos = todoManager.setTodos(
          todosWithSourceMessageId,
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
