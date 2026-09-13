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
    const context = makeContext();
    const result = await runTool(createTodoWrite(context), {
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
    expect(context.todoManager.getRunMetrics()).toEqual({
      initialTodoCount: 0,
      initialUnfinishedTodoCount: 0,
      finalTodoCount: 2,
      finalUnfinishedTodoCount: 2,
      todoWriteCount: 1,
      todoCreatedThisRunCount: 2,
      todoUpdatedThisRunCount: 0,
      todoRemovedThisRunCount: 0,
      currentRunTodoCount: 2,
      currentRunUnfinishedTodoCount: 2,
    });
  });

  it("allows partial merge updates for existing todos", async () => {
    const context = makeContext([
      { id: "1", content: "Plan test", status: "in_progress" },
    ]);
    const result = await runTool(createTodoWrite(context), {
      merge: true,
      todos: [{ id: "1", status: "completed" }],
    });

    expect(result).toMatchObject({
      counts: { completed: 1, total: 1 },
      currentTodos: [{ id: "1", content: "Plan test", status: "completed" }],
    });
    expect(context.todoManager.getRunMetrics()).toEqual({
      initialTodoCount: 1,
      initialUnfinishedTodoCount: 1,
      finalTodoCount: 1,
      finalUnfinishedTodoCount: 0,
      todoWriteCount: 1,
      todoCreatedThisRunCount: 0,
      todoUpdatedThisRunCount: 1,
      todoRemovedThisRunCount: 0,
      currentRunTodoCount: 1,
      currentRunUnfinishedTodoCount: 0,
    });
  });

  it("skips exact normalized duplicate assistant todos and reports their ids", async () => {
    const context = makeContext();
    const result = await runTool(createTodoWrite(context), {
      merge: false,
      todos: [
        { id: "first", content: "Review auth flow", status: "in_progress" },
        {
          id: "duplicate",
          content: "  review   AUTH flow  ",
          status: "pending",
        },
        {
          id: "distinct",
          content: "Review auth flow on mobile",
          status: "pending",
        },
      ],
    });

    expect(result).toMatchObject({
      result: expect.stringContaining(
        "Skipped new to-do IDs with exact duplicate normalized content matching an earlier item in this write or a preserved manual to-do: duplicate.",
      ),
      skippedTodoIds: ["duplicate"],
      counts: { completed: 0, total: 2 },
      currentTodos: [
        { id: "first", content: "Review auth flow" },
        { id: "distinct", content: "Review auth flow on mobile" },
      ],
    });
  });

  it("keeps manual todos and skips new assistant duplicates of them", async () => {
    const context = makeContext([
      { id: "manual", content: "Review auth flow", status: "pending" },
    ]);
    const result = await runTool(createTodoWrite(context), {
      merge: true,
      todos: [
        { id: "duplicate", content: "review auth flow", status: "pending" },
        { id: "new", content: "Verify remediation", status: "pending" },
      ],
    });

    expect(result).toMatchObject({
      skippedTodoIds: ["duplicate"],
      counts: { completed: 0, total: 2 },
      currentTodos: [
        { id: "manual", content: "Review auth flow" },
        { id: "new", content: "Verify remediation" },
      ],
    });
  });

  it("tracks unique todo changes without treating inherited todos as current-run work", async () => {
    const context = makeContext([
      { id: "stale", content: "Old work", status: "pending" },
      { id: "active", content: "Current work", status: "in_progress" },
    ]);
    const tool = createTodoWrite(context);

    await runTool(tool, {
      merge: true,
      todos: [
        { id: "active", status: "completed" },
        { id: "new", content: "New work", status: "pending" },
      ],
    });
    await runTool(tool, {
      merge: true,
      todos: [{ id: "new", status: "in_progress" }],
    });

    expect(context.todoManager.getRunMetrics()).toEqual({
      initialTodoCount: 2,
      initialUnfinishedTodoCount: 2,
      finalTodoCount: 3,
      finalUnfinishedTodoCount: 2,
      todoWriteCount: 2,
      todoCreatedThisRunCount: 1,
      todoUpdatedThisRunCount: 2,
      todoRemovedThisRunCount: 0,
      currentRunTodoCount: 2,
      currentRunUnfinishedTodoCount: 1,
    });
  });

  it("tracks assistant todos removed by a replacement plan", async () => {
    const context = makeContext([
      {
        id: "old",
        content: "Old plan",
        status: "pending",
        sourceMessageId: "assistant-old",
      },
    ]);

    await runTool(createTodoWrite(context), {
      merge: false,
      todos: [{ id: "new", content: "New plan", status: "in_progress" }],
    });

    expect(context.todoManager.getRunMetrics()).toEqual({
      initialTodoCount: 1,
      initialUnfinishedTodoCount: 1,
      finalTodoCount: 1,
      finalUnfinishedTodoCount: 1,
      todoWriteCount: 1,
      todoCreatedThisRunCount: 1,
      todoUpdatedThisRunCount: 0,
      todoRemovedThisRunCount: 1,
      currentRunTodoCount: 1,
      currentRunUnfinishedTodoCount: 1,
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
