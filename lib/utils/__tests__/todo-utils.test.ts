import { describe, it, expect } from "@jest/globals";
import {
  mergeTodos,
  applyTodoWriteUpdate,
  TodoUpdateError,
  hasPartialTodos,
  shouldTreatAsMerge,
  computeReplaceAssistantTodos,
  getBaseTodosForRequest,
  areTodosEqual,
  getTodoStats,
  getVisibleTodoBlockItems,
  getTodoPanelViewState,
  removeTodosBySourceMessage,
  removeTodosBySourceMessages,
} from "../todo-utils";
import type { Todo } from "@/types";

describe("todo-utils", () => {
  describe("mergeTodos", () => {
    it("should merge new todos with existing ones", () => {
      const currentTodos: Todo[] = [
        { id: "1", content: "Task 1", status: "pending" },
        { id: "2", content: "Task 2", status: "in_progress" },
      ];
      const newTodos: Todo[] = [
        { id: "2", content: "Task 2 updated", status: "completed" },
        { id: "3", content: "Task 3", status: "pending" },
      ];

      const result = mergeTodos(currentTodos, newTodos);

      expect(result).toHaveLength(3);
      expect(result[1].content).toBe("Task 2 updated");
      expect(result[1].status).toBe("completed");
      expect(result[2].id).toBe("3");
    });

    it("should return same reference if no changes", () => {
      const currentTodos: Todo[] = [
        { id: "1", content: "Task 1", status: "pending" },
      ];
      const newTodos: Todo[] = [
        { id: "1", content: "Task 1", status: "pending" },
      ];

      const result = mergeTodos(currentTodos, newTodos);

      expect(result).toBe(currentTodos);
    });

    it("should preserve existing fields when new values are undefined", () => {
      const currentTodos: Todo[] = [
        {
          id: "1",
          content: "Task 1",
          status: "pending",
          sourceMessageId: "msg1",
        },
      ];
      const newTodos = [{ id: "1", status: "completed" as const }];

      const result = mergeTodos(currentTodos, newTodos);

      expect(result[0].content).toBe("Task 1");
      expect(result[0].status).toBe("completed");
      expect(result[0].sourceMessageId).toBe("msg1");
    });
  });

  describe("applyTodoWriteUpdate", () => {
    it("replaces assistant todos, preserves manual todos, and stamps source message ids", () => {
      const currentTodos: Todo[] = [
        { id: "manual", content: "Manual", status: "pending" },
        {
          id: "old",
          content: "Old assistant",
          status: "pending",
          sourceMessageId: "msg-old",
        },
      ];

      const result = applyTodoWriteUpdate({
        currentTodos,
        incomingTodos: [
          { id: "new", content: "New assistant", status: "in_progress" },
        ],
        merge: false,
        sourceMessageId: "msg-new",
      });

      expect(result.todos).toEqual([
        {
          id: "new",
          content: "New assistant",
          status: "in_progress",
          sourceMessageId: "msg-new",
        },
        { id: "manual", content: "Manual", status: "pending" },
      ]);
      expect(result.changed).toBe(true);
    });

    it("allows partial merge updates for existing todos", () => {
      const result = applyTodoWriteUpdate({
        currentTodos: [{ id: "1", content: "Task 1", status: "in_progress" }],
        incomingTodos: [{ id: "1", status: "completed" }],
        merge: true,
      });

      expect(result.todos).toEqual([
        { id: "1", content: "Task 1", status: "completed" },
      ]);
    });

    it("rejects partial merge updates for new todos", () => {
      expect(() =>
        applyTodoWriteUpdate({
          currentTodos: [],
          incomingTodos: [{ id: "new", status: "pending" }],
          merge: true,
        }),
      ).toThrow(TodoUpdateError);
    });

    it("rejects no-op partial merge updates", () => {
      expect(() =>
        applyTodoWriteUpdate({
          currentTodos: [{ id: "1", content: "Task 1", status: "pending" }],
          incomingTodos: [{ id: "1" }],
          merge: true,
        }),
      ).toThrow('Todo "1" must include content or status to update');
    });

    it("rejects blank content in merge updates", () => {
      expect(() =>
        applyTodoWriteUpdate({
          currentTodos: [{ id: "1", content: "Task 1", status: "pending" }],
          incomingTodos: [{ id: "1", content: "   " }],
          merge: true,
        }),
      ).toThrow('Todo "1" is missing required content field');
    });

    it("deduplicates incoming todos by id and preserves last occurrence order", () => {
      const result = applyTodoWriteUpdate({
        currentTodos: [],
        incomingTodos: [
          { id: "1", content: "First", status: "pending" },
          { id: "2", content: "Second", status: "pending" },
          { id: "1", content: "Last", status: "completed" },
        ],
        merge: false,
      });

      expect(result.todos).toEqual([
        { id: "2", content: "Second", status: "pending" },
        { id: "1", content: "Last", status: "completed" },
      ]);
    });
  });

  describe("hasPartialTodos", () => {
    it("should return true if any todo is missing content or status", () => {
      const todos = [
        { id: "1", content: "Task 1" },
        { id: "2", status: "pending" as const },
      ];

      expect(hasPartialTodos(todos)).toBe(true);
    });

    it("should return false if all todos are complete", () => {
      const todos = [
        { id: "1", content: "Task 1", status: "pending" as const },
        { id: "2", content: "Task 2", status: "completed" as const },
      ];

      expect(hasPartialTodos(todos)).toBe(false);
    });

    it("should return false for undefined or non-array input", () => {
      expect(hasPartialTodos(undefined)).toBe(false);
    });
  });

  describe("shouldTreatAsMerge", () => {
    it("should return true if merge flag is true", () => {
      expect(shouldTreatAsMerge(true, [])).toBe(true);
    });

    it("should return true if todos are partial", () => {
      const todos = [{ id: "1", content: "Task 1" }];
      expect(shouldTreatAsMerge(false, todos)).toBe(true);
    });

    it("should return false if merge flag is false and todos are complete", () => {
      const todos = [
        { id: "1", content: "Task 1", status: "pending" as const },
      ];
      expect(shouldTreatAsMerge(false, todos)).toBe(false);
    });
  });

  describe("computeReplaceAssistantTodos", () => {
    it("should replace assistant todos while preserving manual ones", () => {
      const currentTodos: Todo[] = [
        { id: "1", content: "Manual task", status: "pending" },
        {
          id: "2",
          content: "Assistant task",
          status: "pending",
          sourceMessageId: "msg1",
        },
      ];
      const incoming: Todo[] = [
        { id: "3", content: "New assistant task", status: "pending" },
      ];

      const result = computeReplaceAssistantTodos(currentTodos, incoming);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("3");
      expect(result[1].id).toBe("1");
    });

    it("should stamp incoming todos with sourceMessageId if provided", () => {
      const currentTodos: Todo[] = [];
      const incoming: Todo[] = [
        { id: "1", content: "Task", status: "pending" },
      ];

      const result = computeReplaceAssistantTodos(
        currentTodos,
        incoming,
        "msg2",
      );

      expect(result[0].sourceMessageId).toBe("msg2");
    });
  });

  describe("getBaseTodosForRequest", () => {
    it("should return incoming todos for temporary chats", () => {
      const existing: Todo[] = [
        { id: "1", content: "Existing", status: "pending" },
      ];
      const incoming: Todo[] = [
        { id: "2", content: "Incoming", status: "pending" },
      ];

      const result = getBaseTodosForRequest(existing, incoming, {
        isTemporary: true,
      });

      expect(result).toBe(incoming);
    });

    it("should return only manual todos on regenerate for non-temporary", () => {
      const existing: Todo[] = [
        { id: "1", content: "Manual", status: "pending" },
        {
          id: "2",
          content: "Assistant",
          status: "pending",
          sourceMessageId: "msg1",
        },
      ];

      const result = getBaseTodosForRequest(existing, [], {
        isTemporary: false,
        regenerate: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("1");
    });

    it("should return existing todos for non-temporary non-regenerate", () => {
      const existing: Todo[] = [
        { id: "1", content: "Task", status: "pending" },
      ];

      const result = getBaseTodosForRequest(existing, [], {
        isTemporary: false,
      });

      expect(result).toBe(existing);
    });
  });

  describe("areTodosEqual", () => {
    it("should return true for equal todos", () => {
      const todo1: Todo = { id: "1", content: "Task", status: "pending" };
      const todo2: Todo = { id: "2", content: "Task", status: "pending" };

      expect(areTodosEqual(todo1, todo2)).toBe(true);
    });

    it("should return false for different todos", () => {
      const todo1: Todo = { id: "1", content: "Task 1", status: "pending" };
      const todo2: Todo = { id: "2", content: "Task 2", status: "completed" };

      expect(areTodosEqual(todo1, todo2)).toBe(false);
    });
  });

  describe("getTodoStats", () => {
    it("should calculate correct statistics", () => {
      const todos: Todo[] = [
        { id: "1", content: "Task 1", status: "completed" },
        { id: "2", content: "Task 2", status: "in_progress" },
        { id: "3", content: "Task 3", status: "pending" },
        { id: "4", content: "Task 4", status: "cancelled" },
      ];

      const stats = getTodoStats(todos);

      expect(stats).toEqual({
        completed: 1,
        inProgress: 1,
        pending: 1,
        cancelled: 1,
        total: 4,
        done: 2,
      });
    });
  });

  describe("todo view helpers", () => {
    it("treats cancelled as done for block visibility", () => {
      const todos: Todo[] = [
        { id: "1", content: "Completed", status: "completed" },
        { id: "2", content: "Cancelled", status: "cancelled" },
        { id: "3", content: "Current", status: "in_progress" },
      ];

      const visible = getVisibleTodoBlockItems({ todos });

      expect(visible.map((todo) => todo.id)).toEqual(["2", "3"]);
    });

    it("marks an in-progress todo as paused when chat is ready", () => {
      const state = getTodoPanelViewState(
        [{ id: "1", content: "Current", status: "in_progress" }],
        "ready",
      );

      expect(state.isPaused).toBe(true);
      expect(state.currentTodoDisplayStatus).toBe("paused");
    });
  });

  describe("removeTodosBySourceMessage", () => {
    it("should remove todos with matching sourceMessageId", () => {
      const todos: Todo[] = [
        {
          id: "1",
          content: "Task 1",
          status: "pending",
          sourceMessageId: "msg1",
        },
        {
          id: "2",
          content: "Task 2",
          status: "pending",
          sourceMessageId: "msg2",
        },
        { id: "3", content: "Task 3", status: "pending" },
      ];

      const result = removeTodosBySourceMessage(todos, "msg1");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("2");
      expect(result[1].id).toBe("3");
    });
  });

  describe("removeTodosBySourceMessages", () => {
    it("should remove todos with any matching sourceMessageId", () => {
      const todos: Todo[] = [
        {
          id: "1",
          content: "Task 1",
          status: "pending",
          sourceMessageId: "msg1",
        },
        {
          id: "2",
          content: "Task 2",
          status: "pending",
          sourceMessageId: "msg2",
        },
        {
          id: "3",
          content: "Task 3",
          status: "pending",
          sourceMessageId: "msg3",
        },
        { id: "4", content: "Task 4", status: "pending" },
      ];

      const result = removeTodosBySourceMessages(todos, ["msg1", "msg3"]);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("2");
      expect(result[1].id).toBe("4");
    });

    it("should return same array if no message ids provided", () => {
      const todos: Todo[] = [
        {
          id: "1",
          content: "Task 1",
          status: "pending",
          sourceMessageId: "msg1",
        },
      ];

      const result = removeTodosBySourceMessages(todos, []);

      expect(result).toBe(todos);
    });
  });
});
