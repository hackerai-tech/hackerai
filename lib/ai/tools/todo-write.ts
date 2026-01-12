import { tool } from "ai";
import { z } from "zod";
import type { ToolContext, Todo } from "@/types";

export const createTodoWrite = (context: ToolContext) => {
  const { todoManager, assistantMessageId } = context;

  return tool({
    description: `Use this tool to create and manage a structured task list for your penetration testing session. This helps track progress, organize complex security assessments, and ensure thorough coverage.

Note: Other than when first creating todos, don't tell the user you're updating todos, just do it.

### When to Use This Tool

Use proactively for:
1. Complex multi-step security assessments (3+ distinct steps)
2. Non-trivial vulnerability testing requiring systematic approach
3. User explicitly requests todo list
4. User provides multiple targets or attack vectors (numbered/comma-separated)
5. After receiving new instructions - capture requirements as todos (use merge=false to add new ones)
6. After completing tasks - mark complete with merge=true and add follow-ups
7. When starting new tasks - mark as in_progress (ideally only one at a time)

### When NOT to Use

Skip for:
1. Single, straightforward checks
2. Quick reconnaissance queries
3. Tasks completable in < 3 trivial steps
4. Purely informational requests about security concepts

NEVER INCLUDE THESE IN TODOS: basic enumeration steps; reading tool output; routine scanning operations.

### Examples

<example>
  User: Test the authentication system for vulnerabilities
  Assistant:
    - *Creates todo list:*
      1. Test login endpoint for SQL injection [in_progress]
      2. Check for authentication bypass vectors
      3. Analyze session management weaknesses
      4. Test password reset flow for flaws
    - [Immediately begins working on todo 1 in the same tool call batch]
<reasoning>
  Multi-step security assessment with multiple attack surfaces.
</reasoning>
</example>

<example>
  User: Perform a full security assessment of the /api endpoints
  Assistant: *Enumerates endpoints, identifies 12 routes across 5 controllers*
  *Creates todo list with specific items for each endpoint category*

<reasoning>
  Complex assessment requiring systematic tracking across multiple attack surfaces.
</reasoning>
</example>

<example>
  User: Check for IDOR, XSS, SSRF, and privilege escalation vulnerabilities
  Assistant: *Creates todo list breaking down each vulnerability class into specific tests*

<reasoning>
  Multiple vulnerability categories provided requiring organized testing approach.
</reasoning>
</example>

<example>
  User: The admin panel seems insecure - find all the issues
  Assistant: *Analyzes admin functionality, identifies attack vectors*
  *Creates todo list: 1) Test access controls, 2) Check for privilege escalation, 3) Analyze file upload functionality, 4) Test for CSRF, 5) Check sensitive data exposure*

<reasoning>
  Comprehensive security assessment requires multiple testing phases.
</reasoning>
</example>

### Examples of When NOT to Use the Todo List

<example>
  User: What is SQL injection?
  Assistant: SQL injection is a code injection technique...

<reasoning>
  Informational request with no testing task to complete.
</reasoning>
</example>

<example>
  User: Run a quick port scan on the target
  Assistant: *Executes port scan* Results show ports 22, 80, 443 open...

<reasoning>
  Single straightforward scan with immediate results.
</reasoning>
</example>

<example>
  User: Check if this URL is vulnerable to path traversal
  Assistant: *Tests for path traversal* The endpoint appears to sanitize input...

<reasoning>
  Single targeted test on one endpoint.
</reasoning>
</example>

### Task States and Management

1. **Task States:**
  - pending: Not yet started
  - in_progress: Currently testing
  - completed: Finished successfully
  - cancelled: No longer relevant

2. **Task Management:**
  - Update status in real-time
  - Mark complete IMMEDIATELY after finishing
  - Only ONE task in_progress at a time
  - Complete current tasks before starting new ones

3. **Task Breakdown:**
  - Create specific, actionable security tests
  - Break complex assessments into targeted checks
  - Use clear, descriptive names (e.g., "Test /api/users for IDOR")

4. **Parallel Todo Writes:**
  - Prefer creating the first todo as in_progress
  - Start working on todos by using tool calls in the same tool call batch as the todo write
  - Batch todo updates with other tool calls for efficiency

When in doubt, use this tool. Systematic task management ensures comprehensive security coverage and prevents missed vulnerabilities.`,
    inputSchema: z.object({
      merge: z
        .boolean()
        .describe(
          "Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos.",
        ),
      todos: z
        .array(
          z.object({
            id: z.string().describe("Unique identifier for the todo item"),
            content: z
              .string()
              .describe("The description/content of the todo item"),
            status: z
              .enum(["pending", "in_progress", "completed", "cancelled"])
              .describe("The current status of the todo item"),
          }),
        )
        .min(1)
        .describe("Array of todo items to write to the workspace"),
    }),
    execute: async ({
      merge,
      todos,
    }: {
      merge: boolean;
      todos: Array<{
        id: string;
        content?: string;
        status: Todo["status"];
      }>;
    }) => {
      try {
        // Runtime validation for non-merge operations
        if (!merge) {
          for (let i = 0; i < todos.length; i++) {
            const todo = todos[i];
            if (!todo.content || todo.content.trim() === "") {
              throw new Error(
                `Todo at index ${i} is missing required content field`,
              );
            }
          }
        }

        // If incoming payload looks like partial updates (missing content fields), switch to merge to avoid replacing the whole plan.
        const shouldMerge =
          merge ||
          todos.some((t) => t.content === undefined || t.content === null);

        // Update backend state first (TodoManager handles deduplication)
        const updatedTodos = todoManager.setTodos(
          // When creating a plan (shouldMerge=false), stamp todos with assistantMessageId
          shouldMerge || !assistantMessageId
            ? todos
            : todos.map((t) => ({ ...t, sourceMessageId: assistantMessageId })),
          shouldMerge,
        );

        // Get current stats from the manager
        const stats = todoManager.getStats();
        const action = shouldMerge ? "updated" : "created";

        const counts = {
          completed: stats.done, // Use 'done' which includes both completed and cancelled
          total: stats.total,
        };

        // Include current todos in response for visibility
        const currentTodos = updatedTodos.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status,
          sourceMessageId: t.sourceMessageId,
        }));

        return {
          result: `Successfully ${action} to-dos. Make sure to follow and update your to-do list as you make progress. Cancel and add new to-do tasks as needed when the user makes a correction or follow-up request.${
            stats.inProgress === 0
              ? " No to-dos are marked in-progress, make sure to mark them before starting the next."
              : ""
          }`,
          counts,
          currentTodos,
        };
      } catch (error) {
        return {
          error: `Failed to manage todos: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
