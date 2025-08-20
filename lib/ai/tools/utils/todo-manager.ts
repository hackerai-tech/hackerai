export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

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
    if (!merge) {
      // Replace all todos
      this.todos = [];
    }

    for (const todo of newTodos) {
      // Defensive check - should never happen with proper typing, but provides clear error
      if (!todo.id) {
        throw new Error("Todo must have an id");
      }

      const existingIndex = this.todos.findIndex((t) => t.id === todo.id);

      if (existingIndex >= 0) {
        // Update existing todo, preserve existing content if not provided
        this.todos[existingIndex] = {
          id: todo.id,
          content: todo.content ?? this.todos[existingIndex].content,
          status: todo.status ?? this.todos[existingIndex].status,
        };
      } else {
        // Add new todo
        // If it's the first time (not merge) and content is missing, throw error
        if (!merge && !todo.content) {
          throw new Error(`Content is required for new todos.`);
        }

        this.todos.push({
          id: todo.id,
          content: todo.content ?? "",
          status: todo.status ?? "pending",
        });
      }
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
}
