import type { Todo } from "@/types/chat";
import { applyTodoWriteUpdate } from "@/lib/utils/todo-utils";

export interface TodoUpdate {
  id: string;
  content?: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled";
}

export type TodoRunMetrics = {
  initialTodoCount: number;
  initialUnfinishedTodoCount: number;
  finalTodoCount: number;
  finalUnfinishedTodoCount: number;
  todoWriteCount: number;
  todoCreatedThisRunCount: number;
  todoUpdatedThisRunCount: number;
  todoRemovedThisRunCount: number;
  currentRunTodoCount: number;
  currentRunUnfinishedTodoCount: number;
};

const isUnfinishedTodo = (todo: Todo): boolean =>
  todo.status === "pending" || todo.status === "in_progress";

/**
 * TodoManager handles backend state management for todos during tool execution.
 * It maintains the current state of todos in memory for the duration of the conversation.
 */
export class TodoManager {
  private todos: Todo[] = [];
  private hasCreatedPlanThisRun: boolean = false;
  private readonly initialTodoCount: number;
  private readonly initialUnfinishedTodoCount: number;
  private todoWriteCount = 0;
  private readonly createdTodoIds = new Set<string>();
  private readonly updatedTodoIds = new Set<string>();
  private readonly removedTodoIds = new Set<string>();

  constructor(initialTodos?: Todo[]) {
    if (initialTodos) {
      this.todos = [...initialTodos];
    }
    this.initialTodoCount = this.todos.length;
    this.initialUnfinishedTodoCount =
      this.todos.filter(isUnfinishedTodo).length;
  }

  /**
   * Get all current todos
   */
  getAllTodos(): Todo[] {
    return [...this.todos];
  }

  /**
   * Add or update todos with merge capability
   */
  setTodos(
    newTodos: (Partial<Todo> & { id: string })[],
    merge: boolean = false,
  ): Todo[] {
    const previousTodos = this.todos;
    const result = applyTodoWriteUpdate({
      currentTodos: previousTodos,
      incomingTodos: newTodos,
      merge,
    });

    this.todos = result.todos;
    this.todoWriteCount += 1;

    const previousById = new Map(
      previousTodos.map((todo) => [todo.id, todo] as const),
    );
    const currentById = new Map(
      this.todos.map((todo) => [todo.id, todo] as const),
    );

    for (const todo of this.todos) {
      const previous = previousById.get(todo.id);
      if (!previous) {
        this.createdTodoIds.add(todo.id);
      } else if (
        previous.content !== todo.content ||
        previous.status !== todo.status
      ) {
        this.updatedTodoIds.add(todo.id);
      }
    }

    for (const todo of previousTodos) {
      if (!currentById.has(todo.id)) {
        this.removedTodoIds.add(todo.id);
      }
    }

    if (!merge) {
      this.hasCreatedPlanThisRun = true;
    }

    return this.getAllTodos();
  }

  /**
   * Get current stats
   */
  getStats() {
    const todos = this.getAllTodos();
    const completed = todos.filter((t) => t.status === "completed").length;
    const cancelled = todos.filter((t) => t.status === "cancelled").length;

    return {
      total: todos.length,
      pending: todos.filter((t) => t.status === "pending").length,
      inProgress: todos.filter((t) => t.status === "in_progress").length,
      completed: completed,
      cancelled: cancelled,
      // Count both completed and cancelled as "done" for progress tracking
      done: completed + cancelled,
    };
  }

  /** Return privacy-safe counts describing todo changes during this run. */
  getRunMetrics(): TodoRunMetrics {
    const currentRunTodoIds = new Set([
      ...this.createdTodoIds,
      ...this.updatedTodoIds,
    ]);
    const currentRunTodos = this.todos.filter((todo) =>
      currentRunTodoIds.has(todo.id),
    );

    return {
      initialTodoCount: this.initialTodoCount,
      initialUnfinishedTodoCount: this.initialUnfinishedTodoCount,
      finalTodoCount: this.todos.length,
      finalUnfinishedTodoCount: this.todos.filter(isUnfinishedTodo).length,
      todoWriteCount: this.todoWriteCount,
      todoCreatedThisRunCount: this.createdTodoIds.size,
      todoUpdatedThisRunCount: this.updatedTodoIds.size,
      todoRemovedThisRunCount: this.removedTodoIds.size,
      currentRunTodoCount: currentRunTodos.length,
      currentRunUnfinishedTodoCount:
        currentRunTodos.filter(isUnfinishedTodo).length,
    };
  }

  /**
   * Merge base todos (from client/request) with current manager todos (tool-updated)
   * and tag only newly generated/updated todos with the provided assistantMessageId.
   */
  mergeWith(baseTodos: Todo[] | undefined, assistantMessageId: string): Todo[] {
    const base: Todo[] = Array.isArray(baseTodos) ? baseTodos : [];
    const baseIdSet = new Set(base.map((t) => t.id));

    const idToTodo: Record<string, Todo> = {};
    for (const t of base) {
      idToTodo[t.id] = t;
    }

    for (const t of this.todos) {
      const shouldTag =
        this.hasCreatedPlanThisRun &&
        !t.sourceMessageId &&
        !baseIdSet.has(t.id);
      idToTodo[t.id] = shouldTag
        ? { ...t, sourceMessageId: assistantMessageId }
        : t;
    }

    return Object.values(idToTodo);
  }
}
