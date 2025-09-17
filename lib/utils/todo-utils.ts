import type { Todo } from "@/types";

/**
 * Efficiently merges new todos with existing ones.
 * Only creates a new array if there are actual changes to prevent unnecessary re-renders.
 *
 * @param currentTodos - The current array of todos
 * @param newTodos - The new todos to merge
 * @returns Updated todos array (same reference if no changes)
 */
export const mergeTodos = (
  currentTodos: Todo[],
  newTodos: ReadonlyArray<TodoLike>,
): Todo[] => {
  let hasChanges = false;
  const updatedTodos = [...currentTodos];

  for (const newTodo of newTodos) {
    const existingIndex = updatedTodos.findIndex((t) => t.id === newTodo.id);

    if (existingIndex >= 0) {
      // Check if the todo actually changed
      const existing = updatedTodos[existingIndex];
      const merged: Todo = {
        ...existing,
        // Preserve existing fields when incoming values are undefined
        content:
          newTodo.content !== undefined ? newTodo.content : existing.content,
        status: newTodo.status !== undefined ? newTodo.status : existing.status,
        sourceMessageId:
          newTodo.sourceMessageId !== undefined
            ? newTodo.sourceMessageId
            : existing.sourceMessageId,
      };

      if (
        existing.content !== merged.content ||
        existing.status !== merged.status ||
        existing.sourceMessageId !== merged.sourceMessageId
      ) {
        updatedTodos[existingIndex] = merged;
        hasChanges = true;
      }
    } else {
      // Add new todo
      if (isCompleteTodoLike(newTodo)) {
        updatedTodos.push(newTodo);
        hasChanges = true;
      }
    }
  }

  // Only return new array if there were actual changes
  return hasChanges ? updatedTodos : currentTodos;
};

/**
 * Lightweight shape for tool payloads which may omit fields like content/status.
 */
export type TodoLike = {
  id: string;
  content?: string;
  status?: Todo["status"];
  sourceMessageId?: string;
};

/**
 * Narrow a `TodoLike` to a full `Todo` by ensuring required fields exist.
 */
const isCompleteTodoLike = (candidate: TodoLike): candidate is Todo => {
  return candidate.content !== undefined && candidate.status !== undefined;
};

/**
 * Returns true if any todo in the array is partial (missing content or status).
 */
export const hasPartialTodos = (
  todos: Array<TodoLike> | undefined,
): boolean => {
  if (!Array.isArray(todos)) return false;
  return todos.some((t) => t.content === undefined || t.status === undefined);
};

/**
 * Determines whether an incoming tool call should be treated as a merge.
 * If any todo is partial, or the merge flag is true, we merge.
 */
export const shouldTreatAsMerge = (
  mergeFlag: boolean | undefined,
  todos: Array<TodoLike> | undefined,
): boolean => {
  return Boolean(mergeFlag) || hasPartialTodos(todos);
};

/**
 * Compute new todos when replacing all assistant-generated todos with incoming ones,
 * while preserving manual todos. Optionally stamp incoming with a source message id.
 */
export const computeReplaceAssistantTodos = (
  currentTodos: Todo[],
  incoming: Todo[],
  sourceMessageId?: string,
): Todo[] => {
  const manual = currentTodos.filter((t) => !t.sourceMessageId);
  const stamped = sourceMessageId
    ? incoming.map((t) => ({ ...t, sourceMessageId }))
    : incoming;
  return [...stamped, ...manual];
};

/**
 * Compute base todos for a request given existing stored todos and incoming todos.
 * - Non-temporary: use stored todos; on regenerate keep only manual todos.
 * - Temporary: rely on incoming todos.
 */
export const getBaseTodosForRequest = (
  existingTodos: Todo[] | undefined,
  incomingTodos: Todo[] | undefined,
  opts: { isTemporary: boolean; regenerate?: boolean },
): Todo[] => {
  const existing: Todo[] = Array.isArray(existingTodos) ? existingTodos : [];
  const incoming: Todo[] = Array.isArray(incomingTodos) ? incomingTodos : [];

  if (opts.isTemporary) return incoming;
  if (opts.regenerate) return existing.filter((t) => !t.sourceMessageId);
  return existing;
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

/**
 * Remove all todos attributed to a given message id.
 */
export const removeTodosBySourceMessage = (
  todos: Todo[],
  messageId: string,
): Todo[] => {
  return todos.filter((t) => t.sourceMessageId !== messageId);
};

/**
 * Remove all todos attributed to any of the given message ids.
 */
export const removeTodosBySourceMessages = (
  todos: Todo[],
  messageIds: string[],
): Todo[] => {
  if (messageIds.length === 0) return todos;
  const idSet = new Set(messageIds);
  return todos.filter((t) => {
    if (!t.sourceMessageId) return true;
    // If the assistant id is in the set, drop the todo
    if (idSet.has(t.sourceMessageId)) return false;
    return true;
  });
};
