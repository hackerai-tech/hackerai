import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import {
  convertToModelMessages,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  startSandbox,
  killSandbox,
  emitWorkflowError,
  saveAssistantMessageStep,
  clearActiveWorkflowRunStep,
} from "./steps/sandbox-steps";
import { openrouterModel } from "./steps/openrouter-model";
import { createWorkflowTools } from "./tools";
import { systemPromptStep } from "./steps/system-prompt-step";
import { persistTodosStep } from "./steps/persist-todos-step";
import type { UploadedFileMetadata } from "./steps/terminal-steps";
import { TodoManager } from "@/lib/ai/tools/utils/todo-manager";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { filterEmptyAssistantMessages } from "@/lib/chat/compaction/prune-tool-outputs";
import type { SubscriptionTier, Todo } from "@/types";
import type { UserCustomization } from "@/types/user";
import type { ModelName } from "@/lib/ai/providers";

export interface WorkflowAgentInput {
  userId: string;
  chatId: string;
  /** Full chat history (existing DB messages merged with the new user turn,
   *  truncated to fit the subscription's token budget). The workflow converts
   *  these to model messages before calling `agent.stream` so the agent has
   *  context of prior turns, not just the latest user prompt. */
  messages: UIMessage[];
  /** Subscription tier for system prompt + memory gating. The route gates
   *  free tier so this is always a paid plan. */
  subscription: SubscriptionTier;
  /** Snapshot of user customization at run start (gates notes, sets persona,
   *  carries guardrails config). */
  userCustomization: UserCustomization | null;
  /** Pre-extracted from `userCustomization.guardrails_config` to keep the
   *  step input small and explicit. */
  guardrailsConfig?: string;
  memoryEnabled: boolean;
  /** ISO country code from `geolocation(req)?.country` for `web_search`. */
  userLocationCountry?: string;
  /** Existing todos from the chat row, used to seed `TodoManager`. */
  initialTodos?: Todo[];
  /** OpenRouter model ID; route always passes a resolved value. */
  model?: ModelName;
  maxSteps?: number;
}

export async function agentRunWorkflow(input: WorkflowAgentInput) {
  "use workflow";

  const writable = getWritable<UIMessageChunk>();
  let sandboxId: string | null = null;

  // Workflow-scope mutable state. Tool factories receive these by reference
  // and update them after each step returns. They are NOT step-shared
  // objects — durable replay re-runs the surrounding code, so the array /
  // manager is reconstructed deterministically from cached step results.
  const fileAccumulator: UploadedFileMetadata[] = [];
  const todoManager = new TodoManager(input.initialTodos);

  try {
    const sandbox = await startSandbox({
      userId: input.userId,
      chatId: input.chatId,
    });
    sandboxId = sandbox.sandboxId;
    const sid: string = sandbox.sandboxId;

    const modelId: ModelName = input.model ?? "agent-model";

    const system = await systemPromptStep({
      userId: input.userId,
      mode: "agent-long",
      subscription: input.subscription,
      modelName: modelId,
      userCustomization: input.userCustomization,
      isTemporary: false,
      sandboxContext: null,
    });

    const tools = createWorkflowTools({
      sandboxId: sid,
      chatId: input.chatId,
      userId: input.userId,
      subscription: input.subscription,
      guardrailsConfig: input.guardrailsConfig,
      memoryEnabled: input.memoryEnabled,
      userLocationCountry: input.userLocationCountry,
      fileAccumulator,
      todoManager,
    });

    const agent = new DurableAgent({
      model: openrouterModel(modelId),
      system,
      tools,
    });

    const result = await agent.stream({
      messages: filterEmptyAssistantMessages(
        await convertToModelMessages(input.messages),
      ),
      writable,
      maxSteps: input.maxSteps ?? 60,
      collectUIMessages: true,
    });

    // Persist accumulated todos before saving the message so a reload after
    // the run shows them (mirrors what chat-handler does at end-of-turn).
    await persistTodosStep({
      chatId: input.chatId,
      todos: todoManager.getAllTodos(),
    });

    // Persist the final assistant UI message so the chat shows the response
    // on reload. uiMessages is populated when collectUIMessages is true.
    const uiTail = result.uiMessages?.[result.uiMessages.length - 1];
    if (uiTail && uiTail.role === "assistant" && Array.isArray(uiTail.parts)) {
      await saveAssistantMessageStep({
        chatId: input.chatId,
        userId: input.userId,
        message: {
          id: uiTail.id,
          role: "assistant",
          parts: uiTail.parts,
        },
        model: modelId,
        finishReason: "stop",
        extraFileIds: fileAccumulator.map((f) => f.fileId),
      });
    }

    return {
      sandboxId: sid,
      messages: result.messages,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    await emitWorkflowError({ errorText: `Workflow failed: ${message}` });
    throw error;
  } finally {
    // Tear down PTY sessions (kill handles, clear timers) before destroying
    // the sandbox they live in. Mirrors `chat-handler.onFinish`'s cleanup.
    try {
      await ptySessionManager.closeAll(input.chatId);
    } catch (e) {
      console.error("[workflow] PTY closeAll failed:", e);
    }
    if (sandboxId) {
      await killSandbox({ sandboxId });
    }
    // Always clear the active run id so the UI doesn't try to reattach to
    // a dead stream after a failed/cancelled run.
    await clearActiveWorkflowRunStep({ chatId: input.chatId });
  }
}
