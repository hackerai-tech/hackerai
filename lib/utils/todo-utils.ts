import type { Todo } from "@/types";

export class TodoUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoUpdateError";
  }
}

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
  const result = applyTodoWriteUpdate({
    currentTodos,
    incomingTodos: newTodos,
    merge: true,
    allowPartialNewTodos: false,
  });

  return result.changed ? result.todos : currentTodos;
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

const hasTodoPatch = (candidate: TodoLike): boolean => {
  return (
    candidate.content !== undefined ||
    candidate.status !== undefined ||
    candidate.sourceMessageId !== undefined
  );
};

export const dedupeTodosById = <T extends { id: string }>(
  todos: ReadonlyArray<T>,
): T[] => Array.from(new Map(todos.map((todo) => [todo.id, todo])).values());

export interface ApplyTodoWriteUpdateOptions {
  currentTodos: Todo[];
  incomingTodos: ReadonlyArray<TodoLike>;
  merge: boolean;
  sourceMessageId?: string;
  preserveManualTodos?: boolean;
  allowPartialNewTodos?: boolean;
}

export interface ApplyTodoWriteUpdateResult {
  todos: Todo[];
  stats: TodoStats;
  changed: boolean;
}

export const applyTodoWriteUpdate = ({
  currentTodos,
  incomingTodos,
  merge,
  sourceMessageId,
  preserveManualTodos = true,
  allowPartialNewTodos = false,
}: ApplyTodoWriteUpdateOptions): ApplyTodoWriteUpdateResult => {
  const uniqueIncoming = dedupeTodosById(incomingTodos);

  if (!merge) {
    const fullTodos: Todo[] = uniqueIncoming.map((todo, index) => {
      if (!todo.id) {
        throw new TodoUpdateError(`Todo at index ${index} is missing id`);
      }
      if (!todo.content || todo.content.trim() === "") {
        throw new TodoUpdateError(
          `Todo at index ${index} is missing required content field`,
        );
      }
      if (!todo.status) {
        throw new TodoUpdateError(
          `Todo at index ${index} is missing required status field`,
        );
      }
      return {
        id: todo.id,
        content: todo.content,
        status: todo.status,
        sourceMessageId: sourceMessageId ?? todo.sourceMessageId,
      };
    });

    const manualTodos = preserveManualTodos
      ? currentTodos.filter((todo) => !todo.sourceMessageId)
      : [];
    const todos = [...fullTodos, ...manualTodos];

    return {
      todos,
      stats: getTodoStats(todos),
      changed: !areTodoListsEqual(currentTodos, todos),
    };
  }

  const updatedTodos = [...currentTodos];

  for (let i = 0; i < uniqueIncoming.length; i++) {
    const newTodo = uniqueIncoming[i];
    if (!newTodo.id) {
      throw new TodoUpdateError(`Todo at index ${i} is missing id`);
    }
    if (!hasTodoPatch(newTodo)) {
      throw new TodoUpdateError(
        `Todo "${newTodo.id}" must include content or status to update`,
      );
    }

    const existingIndex = updatedTodos.findIndex((t) => t.id === newTodo.id);

    if (existingIndex >= 0) {
      const existing = updatedTodos[existingIndex];
      updatedTodos[existingIndex] = {
        ...existing,
        content:
          newTodo.content !== undefined ? newTodo.content : existing.content,
        status: newTodo.status !== undefined ? newTodo.status : existing.status,
        sourceMessageId:
          newTodo.sourceMessageId !== undefined
            ? newTodo.sourceMessageId
            : existing.sourceMessageId,
      };
      continue;
    }

    if (!isCompleteTodoLike(newTodo)) {
      if (allowPartialNewTodos) {
        continue;
      }
      throw new TodoUpdateError(
        `Content and status are required for new todo "${newTodo.id}"`,
      );
    }

    updatedTodos.push(newTodo);
  }

  return {
    todos: updatedTodos,
    stats: getTodoStats(updatedTodos),
    changed: !areTodoListsEqual(currentTodos, updatedTodos),
  };
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
  return applyTodoWriteUpdate({
    currentTodos,
    incomingTodos: incoming,
    merge: false,
    sourceMessageId,
  }).todos;
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
 * Checks if two todos have the same persisted display fields.
 */
export const areTodosEqual = (todo1: Todo, todo2: Todo): boolean => {
  return (
    todo1.content === todo2.content &&
    todo1.status === todo2.status &&
    todo1.sourceMessageId === todo2.sourceMessageId
  );
};

export const areTodoListsEqual = (todos1: Todo[], todos2: Todo[]): boolean => {
  if (todos1.length !== todos2.length) return false;
  return todos1.every(
    (todo, index) =>
      todo.id === todos2[index].id && areTodosEqual(todo, todos2[index]),
  );
};

/**
 * Gets todo statistics for display purposes
 */
export type TodoStats = {
  completed: number;
  inProgress: number;
  pending: number;
  cancelled: number;
  total: number;
  done: number;
};

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

export const getTodoDisplayData = (todos: Todo[]) => {
  const uniqueTodos = dedupeTodosById(todos);
  const byStatus = {
    completed: uniqueTodos.filter((t) => t.status === "completed"),
    inProgress: uniqueTodos.filter((t) => t.status === "in_progress"),
    pending: uniqueTodos.filter((t) => t.status === "pending"),
    cancelled: uniqueTodos.filter((t) => t.status === "cancelled"),
  };
  const stats = getTodoStats(uniqueTodos);
  const currentInProgress = byStatus.inProgress[0];
  const lastCompleted = byStatus.completed[byStatus.completed.length - 1];
  const lastCancelled = byStatus.cancelled[byStatus.cancelled.length - 1];
  const lastDone = (() => {
    if (!lastCompleted) return lastCancelled;
    if (!lastCancelled) return lastCompleted;
    const completedIndex = uniqueTodos.findIndex(
      (todo) => todo.id === lastCompleted.id,
    );
    const cancelledIndex = uniqueTodos.findIndex(
      (todo) => todo.id === lastCancelled.id,
    );
    return completedIndex > cancelledIndex ? lastCompleted : lastCancelled;
  })();

  return {
    todos: uniqueTodos,
    byStatus,
    stats,
    currentInProgress,
    lastCompleted,
    lastCancelled,
    lastDone,
    hasProgress: stats.done > 0,
    allDone: stats.total > 0 && stats.done === stats.total,
  };
};

export const getVisibleTodoBlockItems = ({
  todos,
  inputTodos,
  showAllTodos = false,
}: {
  todos: Todo[];
  inputTodos?: ReadonlyArray<TodoLike>;
  showAllTodos?: boolean;
}): Todo[] => {
  const todoData = getTodoDisplayData(todos);
  const { stats, currentInProgress, lastDone } = todoData;
  const uniqueTodos = todoData.todos;

  if (stats.done === 0 || showAllTodos) {
    return uniqueTodos;
  }

  const visibleTodos: Todo[] = [];

  if (inputTodos && inputTodos.length > 0) {
    const inputTodoIds = new Set(inputTodos.map((t) => t.id));
    visibleTodos.push(
      ...uniqueTodos.filter((todo) => inputTodoIds.has(todo.id)),
    );
  } else if (lastDone) {
    visibleTodos.push(lastDone);
  }

  if (
    currentInProgress &&
    !visibleTodos.some((todo) => todo.id === currentInProgress.id)
  ) {
    visibleTodos.push(currentInProgress);
  }

  if (!currentInProgress && visibleTodos.length === 0) {
    const nextPending = uniqueTodos.find((todo) => todo.status === "pending");
    if (nextPending) {
      visibleTodos.push(nextPending);
    }
  }

  return visibleTodos;
};

export const getTodoPanelViewState = (
  todos: Todo[],
  status?: "submitted" | "streaming" | "ready" | "error",
) => {
  const todoData = getTodoDisplayData(todos);
  const { stats, todos: uniqueTodos } = todoData;
  const hasTodos = uniqueTodos.length > 0;
  const hasActiveTodos = stats.inProgress > 0 || stats.pending > 0;

  const currentTodoIndex = (() => {
    const inProgressIdx = uniqueTodos.findIndex(
      (todo) => todo.status === "in_progress",
    );
    if (inProgressIdx !== -1) return inProgressIdx;
    for (let i = uniqueTodos.length - 1; i >= 0; i--) {
      const todoStatus = uniqueTodos[i].status;
      if (todoStatus === "completed" || todoStatus === "cancelled") return i;
    }
    return -1;
  })();

  const currentTodo =
    currentTodoIndex !== -1 ? uniqueTodos[currentTodoIndex] : undefined;
  const isPaused = status === "ready" && stats.inProgress > 0;
  const currentTodoDisplayStatus: Todo["status"] | "paused" | undefined =
    currentTodo && isPaused && currentTodo.status === "in_progress"
      ? "paused"
      : currentTodo?.status;

  return {
    ...todoData,
    hasTodos,
    hasActiveTodos,
    currentTodoIndex,
    currentTodo,
    isPaused,
    currentTodoDisplayStatus,
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
