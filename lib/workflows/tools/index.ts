/**
 * Workflow tool factory — builds tool definitions for the durable
 * `DurableAgent` that share descriptions and Zod schemas with the normal
 * AI-SDK agent (see `lib/ai/tools/*.ts`). Each tool's `execute` is a thin
 * wrapper that calls `"use step"` step functions in `../steps/*` and
 * forwards results unchanged so the UI sidebar renders them identically.
 *
 * PTY note: `run_terminal_cmd interactive=true` and `interact_terminal_session`
 * use the same in-memory `ptySessionManager` singleton as the chat handler.
 * Sessions live for one agent turn — closed in `agent-run.ts`'s finally block.
 * Workflow PTY does NOT stream `data-terminal` events; the final tool result
 * carries `sessionSnapshot` for sidebar rendering (one block per call).
 *
 * Out of scope for the workflow durable agent (intentionally absent):
 *   - Caido proxy tools (depend on persistent in-process state)
 */
import { tool, type ToolSet } from "ai";
// Import from `lib/ai/tools/schemas` (pure Zod, no Node.js imports) so the
// workflow scope doesn't transitively pull in `node:crypto`, E2B SDK, etc.
// from the AI-SDK factory files.
import {
  RUN_TERMINAL_CMD_DESCRIPTION,
  RUN_TERMINAL_CMD_WORKFLOW_INPUT_SCHEMA,
  INTERACT_TERMINAL_SESSION_DESCRIPTION,
  INTERACT_TERMINAL_SESSION_INPUT_SCHEMA,
  INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS,
  INTERACT_TERMINAL_SESSION_MAX_WAIT_TIMEOUT_SECONDS,
  FILE_DESCRIPTION,
  FILE_INPUT_SCHEMA,
  GET_TERMINAL_FILES_DESCRIPTION,
  GET_TERMINAL_FILES_INPUT_SCHEMA,
  TODO_WRITE_DESCRIPTION,
  TODO_WRITE_INPUT_SCHEMA,
  CREATE_NOTE_DESCRIPTION,
  CREATE_NOTE_INPUT_SCHEMA,
  LIST_NOTES_DESCRIPTION,
  LIST_NOTES_INPUT_SCHEMA,
  UPDATE_NOTE_DESCRIPTION,
  UPDATE_NOTE_INPUT_SCHEMA,
  DELETE_NOTE_DESCRIPTION,
  DELETE_NOTE_INPUT_SCHEMA,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_INPUT_SCHEMA,
  OPEN_URL_DESCRIPTION,
  OPEN_URL_INPUT_SCHEMA,
} from "@/lib/ai/tools/schemas";
import {
  fileReadStep,
  fileWriteStep,
  fileAppendStep,
  fileEditStep,
} from "@/lib/workflows/steps/file-steps";
import { fileToModelOutput } from "@/lib/ai/tools/utils/file-impl";
import { updateNoteToModelOutput } from "@/lib/ai/tools/utils/notes-impl";
import {
  runTerminalCmdStep,
  getTerminalFilesStep,
  interactTerminalSessionStep,
  type UploadedFileMetadata,
} from "@/lib/workflows/steps/terminal-steps";
import {
  createNoteStep,
  listNotesStep,
  updateNoteStep,
  deleteNoteStep,
} from "@/lib/workflows/steps/notes-steps";
import { webSearchStep, openUrlStep } from "@/lib/workflows/steps/web-steps";
import type { TodoManager } from "@/lib/ai/tools/utils/todo-manager";
import type { SubscriptionTier, NoteCategory, Todo } from "@/types";

export interface WorkflowToolContext {
  sandboxId: string;
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  guardrailsConfig?: string;
  memoryEnabled: boolean;
  userLocationCountry?: string;
  /** Mutable accumulator pushed by `get_terminal_files` after each call.
   *  Drained by `agentRunWorkflow` at end-of-turn for `extraFileIds` on save. */
  fileAccumulator: UploadedFileMetadata[];
  /** Mutable manager owned by `agentRunWorkflow`; mutated by `todo_write`. */
  todoManager: TodoManager;
  /** Optional sourceMessageId stamp applied when creating new (non-merge) plans. */
  assistantMessageId?: string;
}

export function createWorkflowTools(ctx: WorkflowToolContext): ToolSet {
  const tools: ToolSet = {
    run_terminal_cmd: tool({
      description: RUN_TERMINAL_CMD_DESCRIPTION,
      inputSchema: RUN_TERMINAL_CMD_WORKFLOW_INPUT_SCHEMA,
      execute: async ({ command, is_background, timeout, interactive }) => {
        return runTerminalCmdStep({
          sandboxId: ctx.sandboxId,
          chatId: ctx.chatId,
          command,
          is_background: is_background ?? false,
          interactive: interactive ?? false,
          timeout: timeout ?? 60,
          guardrailsConfig: ctx.guardrailsConfig,
        });
      },
    }),

    interact_terminal_session: tool({
      description: INTERACT_TERMINAL_SESSION_DESCRIPTION,
      inputSchema: INTERACT_TERMINAL_SESSION_INPUT_SCHEMA,
      execute: async ({ action, session, input, timeout }) => {
        const timeoutSeconds = Math.min(
          timeout ?? INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS,
          INTERACT_TERMINAL_SESSION_MAX_WAIT_TIMEOUT_SECONDS,
        );
        return interactTerminalSessionStep({
          sandboxId: ctx.sandboxId,
          chatId: ctx.chatId,
          action,
          sessionId: session,
          input,
          timeoutMs: timeoutSeconds * 1000,
        });
      },
    }),

    file: tool({
      description: FILE_DESCRIPTION,
      inputSchema: FILE_INPUT_SCHEMA,
      execute: async (input): Promise<unknown> => {
        const { action, path, text, range, edits } = input;
        switch (action) {
          case "read":
            return fileReadStep({
              sandboxId: ctx.sandboxId,
              path,
              range: range as [number, number] | undefined,
            });
          case "write":
            if (text === undefined) {
              return { error: "text is required for write action" };
            }
            return fileWriteStep({
              sandboxId: ctx.sandboxId,
              path,
              text,
            });
          case "append":
            if (text === undefined) {
              return { error: "text is required for append action" };
            }
            return fileAppendStep({
              sandboxId: ctx.sandboxId,
              path,
              text,
            });
          case "edit":
            return fileEditStep({
              sandboxId: ctx.sandboxId,
              path,
              edits: edits ?? [],
            });
          default:
            return { error: `Unknown action ${action as string}` };
        }
      },
      toModelOutput: fileToModelOutput,
    }),

    get_terminal_files: tool({
      description: GET_TERMINAL_FILES_DESCRIPTION,
      inputSchema: GET_TERMINAL_FILES_INPUT_SCHEMA,
      execute: async ({ files }) => {
        const result = await getTerminalFilesStep({
          sandboxId: ctx.sandboxId,
          files,
          userId: ctx.userId,
        });
        // Drain uploaded metadata into the workflow-scope accumulator so the
        // run's final `saveAssistantMessageStep` can pass `extraFileIds`.
        // The model never sees `uploaded`; only `result` and `files` are
        // surfaced from the tool return.
        ctx.fileAccumulator.push(...result.uploaded);
        return { result: result.result, files: result.files };
      },
    }),

    todo_write: tool({
      description: TODO_WRITE_DESCRIPTION,
      inputSchema: TODO_WRITE_INPUT_SCHEMA,
      execute: async ({ merge, todos }) => {
        try {
          if (!merge) {
            for (let i = 0; i < todos.length; i++) {
              const t = todos[i];
              if (!t.content || t.content.trim() === "") {
                throw new Error(
                  `Todo at index ${i} is missing required content field`,
                );
              }
            }
          }

          const shouldMerge =
            merge ||
            todos.some((t) => t.content === undefined || t.content === null);

          const updatedTodos = ctx.todoManager.setTodos(
            shouldMerge || !ctx.assistantMessageId
              ? (todos as Array<Partial<Todo> & { id: string }>)
              : (todos.map((t) => ({
                  ...t,
                  sourceMessageId: ctx.assistantMessageId,
                })) as Array<Partial<Todo> & { id: string }>),
            shouldMerge,
          );

          const stats = ctx.todoManager.getStats();
          const action = shouldMerge ? "updated" : "created";

          return {
            result: `Successfully ${action} to-dos. Make sure to follow and update your to-do list as you make progress. Cancel and add new to-do tasks as needed when the user makes a correction or follow-up request.${
              stats.inProgress === 0
                ? " No to-dos are marked in-progress, make sure to mark them before starting the next."
                : ""
            }`,
            counts: { completed: stats.done, total: stats.total },
            currentTodos: updatedTodos.map((t) => ({
              id: t.id,
              content: t.content,
              status: t.status,
              sourceMessageId: t.sourceMessageId,
            })),
          };
        } catch (error) {
          return {
            error: `Failed to manage todos: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    }),

    web_search: tool({
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: WEB_SEARCH_INPUT_SCHEMA,
      execute: async ({ queries, time }) => {
        return webSearchStep({
          queries,
          time,
          userLocationCountry: ctx.userLocationCountry,
        });
      },
    }),

    open_url: tool({
      description: OPEN_URL_DESCRIPTION,
      inputSchema: OPEN_URL_INPUT_SCHEMA,
      execute: async ({ url }) => {
        return openUrlStep({ url });
      },
    }),
  };

  if (ctx.memoryEnabled) {
    tools.create_note = tool({
      description: CREATE_NOTE_DESCRIPTION,
      inputSchema: CREATE_NOTE_INPUT_SCHEMA,
      execute: async ({ title, content, category, tags }) => {
        return createNoteStep({
          userId: ctx.userId,
          title,
          content,
          category: category as NoteCategory | undefined,
          tags,
        });
      },
    });

    tools.list_notes = tool({
      description: LIST_NOTES_DESCRIPTION,
      inputSchema: LIST_NOTES_INPUT_SCHEMA,
      execute: async ({ category, tags, search }) => {
        return listNotesStep({
          userId: ctx.userId,
          category: category as NoteCategory | undefined,
          tags,
          search,
        });
      },
    });

    tools.update_note = tool({
      description: UPDATE_NOTE_DESCRIPTION,
      inputSchema: UPDATE_NOTE_INPUT_SCHEMA,
      execute: async ({ note_id, title, content, tags }) => {
        return updateNoteStep({
          userId: ctx.userId,
          noteId: note_id,
          title,
          content,
          tags,
        });
      },
      toModelOutput: updateNoteToModelOutput,
    });

    tools.delete_note = tool({
      description: DELETE_NOTE_DESCRIPTION,
      inputSchema: DELETE_NOTE_INPUT_SCHEMA,
      execute: async ({ note_id }) => {
        return deleteNoteStep({ userId: ctx.userId, noteId: note_id });
      },
    });
  }

  // Provider-key gating mirrors `lib/ai/tools/index.ts:150-156`.
  if (!process.env.PERPLEXITY_API_KEY) {
    delete tools.web_search;
  }
  if (!process.env.JINA_API_KEY) {
    delete tools.open_url;
  }

  return tools;
}
