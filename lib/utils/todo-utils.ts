import type { Todo } from "@/types";

/**
 * Efficiently merges new todos with existing ones.
 * Only creates a new array if there are actual changes to prevent unnecessary re-renders.
 *
 * @param currentTodos - The current array of todos
 * @param newTodos - The new todos to merge
 * @returns Updated todos array (same reference if no changes)
 */
export const mergeTodos = (currentTodos: Todo[], newTodos: Todo[]): Todo[] => {
  let hasChanges = false;
  const updatedTodos = [...currentTodos];

  for (const newTodo of newTodos) {
    const existingIndex = updatedTodos.findIndex((t) => t.id === newTodo.id);

    if (existingIndex >= 0) {
      // Check if the todo actually changed
      const existing = updatedTodos[existingIndex];
      if (
        existing.content !== newTodo.content ||
        existing.status !== newTodo.status
      ) {
        updatedTodos[existingIndex] = newTodo;
        hasChanges = true;
      }
    } else {
      // Add new todo
      updatedTodos.push(newTodo);
      hasChanges = true;
    }
  }

  // Only return new array if there were actual changes
  return hasChanges ? updatedTodos : currentTodos;
};

/**
 * Checks if two todos are equal (same content and status)
 */
export const areTodosEqual = (todo1: Todo, todo2: Todo): boolean => {
  return todo1.content === todo2.content && todo1.status === todo2.status;
};

/**
 * Gets todo statistics for display purposes
 */
export const getTodoStats = (todos: Todo[]) => {
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const pending = todos.filter((t) => t.status === "pending").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const total = todos.length;
  const done = completed + cancelled;

  return {
    completed,
    inProgress,
    pending,
    cancelled,
    total,
    done,
  };
};
