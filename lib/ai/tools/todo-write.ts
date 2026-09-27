import { tool } from "ai";
import type { ToolContext, Todo } from "@/types";
import { todoWriteTool } from "./schemas";
import {
  dedupeNewAssistantTodosByContent,
  dedupeTodosById,
} from "@/lib/utils/todo-utils";

export const createTodoWrite = (context: ToolContext) => {
  const { todoManager, assistantMessageId } = context;
  const snapshot = () => {
    const stats = todoManager.getStats();
    return {
      currentTodos: todoManager.getAllTodos(),
      counts: { completed: stats.done, total: stats.total },
    };
  };

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
        if (todos.length === 0) {
          if (!merge) {
            throw new Error(
              "Empty replacement is not allowed. Use merge=true and todos=[] to read the current list.",
            );
          }
          return { result: "Current to-dos (read only).", ...snapshot() };
        }
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

        const existingTodos = todoManager.getAllTodos();
        const existingTodoIds = new Set(existingTodos.map((todo) => todo.id));
        const uniqueTodos = dedupeTodosById(todos);
        const { todos: contentDedupedTodos, skippedTodoIds } =
          dedupeNewAssistantTodosByContent(uniqueTodos, {
            existingTodoIds: shouldMerge
              ? existingTodoIds
              : new Set(
                  existingTodos
                    .filter((todo) => todo.sourceMessageId)
                    .map((todo) => todo.id),
                ),
            manualTodos: existingTodos.filter((todo) => !todo.sourceMessageId),
          });
        if (!shouldMerge) {
          const incomingIds = new Set(
            contentDedupedTodos.map((todo) => todo.id),
          );
          const omitted = existingTodos.filter(
            (todo) =>
              todo.sourceMessageId &&
              (todo.status === "pending" || todo.status === "in_progress") &&
              !incomingIds.has(todo.id),
          );
          if (omitted.length > 0) {
            throw new Error(
              `Replacement would remove unfinished to-dos: ${omitted.map((todo) => todo.id).join(", ")}. Use merge=true for incremental changes, or include these tasks in the replacement. Do not cancel them merely to replace the plan.`,
            );
          }
        }
        const todosWithSourceMessageId: Array<Partial<Todo> & { id: string }> =
          assistantMessageId
            ? contentDedupedTodos.map((todo) => {
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
            : contentDedupedTodos;

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
          result: `Successfully ${action} to-dos.${
            skippedTodoIds.length > 0
              ? ` Skipped new to-do IDs with exact duplicate normalized content matching an earlier item in this write or a preserved manual to-do: ${skippedTodoIds.join(", ")}.`
              : ""
          } Follow and update this plan as you make progress. Preserve unfinished tasks across follow-ups and summarization. Cancel only when a task is genuinely obsolete.${
            stats.inProgress === 0
              ? " No to-dos are marked in-progress, make sure to mark them before starting the next."
              : ""
          }`,
          counts,
          currentTodos,
          skippedTodoIds,
        };
      } catch (error) {
        return {
          error: `Failed to manage todos: ${error instanceof Error ? error.message : String(error)}`,
          ...snapshot(),
        };
      }
    },
  });
};
