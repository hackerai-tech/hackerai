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
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Get all current todos
   */
  getAllTodos(): Todo[] {
    return [...this.todos];
  }

  /**
   * Get a specific todo by ID
   */
  getTodo(id: string): Todo | undefined {
    return this.todos.find((todo) => todo.id === id);
  }

  /**
   * Add or update todos with merge capability
   */
  setTodos(newTodos: Partial<Todo>[], merge: boolean = false): Todo[] {
    if (!merge) {
      // Replace all todos
      this.todos = [];
    }

    for (const todo of newTodos) {
      const existingIndex = this.todos.findIndex((t) => t.id === todo.id);

      if (existingIndex >= 0) {
        // Update existing todo, preserve existing content if not provided
        this.todos[existingIndex] = {
          id: todo.id!,
          content: todo.content ?? this.todos[existingIndex].content,
          status: todo.status ?? this.todos[existingIndex].status,
        };
      } else {
        // Add new todo
        this.todos.push({
          id: todo.id!,
          content: todo.content ?? "",
          status: todo.status ?? "pending",
        });
      }
    }

    return this.getAllTodos();
  }

  /**
   * Update specific todos by ID
   */
  updateTodos(updates: TodoUpdate[]): Todo[] {
    for (const update of updates) {
      const existingIndex = this.todos.findIndex((t) => t.id === update.id);
      if (existingIndex >= 0) {
        this.todos[existingIndex] = {
          ...this.todos[existingIndex],
          ...update,
        };
      }
    }

    return this.getAllTodos();
  }

  /**
   * Mark a todo as completed
   */
  completeTodo(id: string): Todo | null {
    const todoIndex = this.todos.findIndex((t) => t.id === id);
    if (todoIndex >= 0) {
      this.todos[todoIndex] = {
        ...this.todos[todoIndex],
        status: "completed",
      };
      return this.todos[todoIndex];
    }
    return null;
  }

  /**
   * Mark a todo as in progress (and optionally mark others as pending)
   */
  startTodo(id: string, exclusiveInProgress: boolean = true): Todo | null {
    const todoIndex = this.todos.findIndex((t) => t.id === id);
    if (todoIndex < 0) return null;

    // If exclusive, mark all other in_progress todos as pending
    if (exclusiveInProgress) {
      for (let i = 0; i < this.todos.length; i++) {
        if (i !== todoIndex && this.todos[i].status === "in_progress") {
          this.todos[i] = {
            ...this.todos[i],
            status: "pending",
          };
        }
      }
    }

    // Mark the target todo as in_progress
    this.todos[todoIndex] = {
      ...this.todos[todoIndex],
      status: "in_progress",
    };
    return this.todos[todoIndex];
  }

  /**
   * Get todos by status
   */
  getTodosByStatus(status: Todo["status"]): Todo[] {
    return this.getAllTodos().filter((todo) => todo.status === status);
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
   * Clear all todos (useful for testing or session reset)
   */
  clear(): void {
    this.todos = [];
  }

  /**
   * Get the session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }
}
