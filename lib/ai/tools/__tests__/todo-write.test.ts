import type { ToolContext } from "@/types";
import { createTodoWrite } from "../todo-write";
import { TodoManager } from "../utils/todo-manager";

function makeContext(
  initialTodos: ConstructorParameters<typeof TodoManager>[0] = [],
) {
  return {
    todoManager: new TodoManager(initialTodos),
    assistantMessageId: "assistant-1",
  } as unknown as ToolContext;
}

async function runTool(
  tool: ReturnType<typeof createTodoWrite>,
  input: Record<string, unknown>,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;

  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

describe("todo_write", () => {
  it("creates a full todo list and returns currentTodos", async () => {
    const result = await runTool(createTodoWrite(makeContext()), {
      merge: false,
      todos: [
        { id: "1", content: "Plan test", status: "in_progress" },
        { id: "2", content: "Verify result", status: "pending" },
      ],
    });

    expect(result).toMatchObject({
      counts: { completed: 0, total: 2 },
      currentTodos: [
        {
          id: "1",
          content: "Plan test",
          status: "in_progress",
          sourceMessageId: "assistant-1",
        },
        {
          id: "2",
          content: "Verify result",
          status: "pending",
          sourceMessageId: "assistant-1",
        },
      ],
    });
  });

  it("allows partial merge updates for existing todos", async () => {
    const result = await runTool(
      createTodoWrite(
        makeContext([{ id: "1", content: "Plan test", status: "in_progress" }]),
      ),
      {
        merge: true,
        todos: [{ id: "1", status: "completed" }],
      },
    );

    expect(result).toMatchObject({
      counts: { completed: 1, total: 1 },
      currentTodos: [{ id: "1", content: "Plan test", status: "completed" }],
    });
  });

  it("stamps merge-created follow-up todos with the assistant message id", async () => {
    const result = await runTool(
      createTodoWrite(
        makeContext([{ id: "1", content: "Plan test", status: "completed" }]),
      ),
      {
        merge: true,
        todos: [{ id: "2", content: "Follow up", status: "pending" }],
      },
    );

    expect(result).toMatchObject({
      counts: { completed: 1, total: 2 },
      currentTodos: [
        { id: "1", content: "Plan test", status: "completed" },
        {
          id: "2",
          content: "Follow up",
          status: "pending",
          sourceMessageId: "assistant-1",
        },
      ],
    });

    const currentTodos = (
      result as { currentTodos: Array<Record<string, unknown>> }
    ).currentTodos;
    expect(currentTodos[0].sourceMessageId).toBeUndefined();
    expect(currentTodos[1]).toHaveProperty("sourceMessageId", "assistant-1");
  });

  it("returns a clear error for blank merge content", async () => {
    const result = await runTool(
      createTodoWrite(
        makeContext([{ id: "1", content: "Plan test", status: "pending" }]),
      ),
      {
        merge: true,
        todos: [{ id: "1", content: "   " }],
      },
    );

    expect(result).toEqual({
      error:
        'Failed to manage todos: Todo "1" is missing required content field',
    });
  });

  it("returns a clear error for partial new todos", async () => {
    const result = await runTool(createTodoWrite(makeContext()), {
      merge: true,
      todos: [{ id: "missing-content", status: "pending" }],
    });

    expect(result).toEqual({
      error:
        'Failed to manage todos: Content and status are required for new todo "missing-content"',
    });
  });
});
