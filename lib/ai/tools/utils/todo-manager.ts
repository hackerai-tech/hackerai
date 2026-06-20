import type { Todo } from "@/types/chat";
import { applyTodoWriteUpdate } from "@/lib/utils/todo-utils";

export interface TodoUpdate {
  id: string;
  content?: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled";
}

/**
 * TodoManager handles backend state management for todos during tool execution.
 * It maintains the current state of todos in memory for the duration of the conversation.
 */
export class TodoManager {
  private todos: Todo[] = [];
  private hasCreatedPlanThisRun: boolean = false;

  constructor(initialTodos?: Todo[]) {
    if (initialTodos) {
      this.todos = [...initialTodos];
    }
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
    const result = applyTodoWriteUpdate({
      currentTodos: this.todos,
      incomingTodos: newTodos,
      merge,
    });

    this.todos = result.todos;

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
