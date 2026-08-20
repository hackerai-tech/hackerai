import { DefaultSandboxManager } from "./utils/sandbox-manager";
import {
  HybridSandboxManager,
  type SandboxPreference,
} from "./utils/hybrid-sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createInteractTerminalSession } from "./interact-terminal-session";
import { createGetTerminalFiles } from "./get-terminal-files";
import { createFile } from "./file";
import { createWebSearch } from "./web-search";
import { createOpenUrlTool } from "./open-url";
import { createTodoWrite } from "./todo-write";
import {
  createCreateNote,
  createListNotes,
  createUpdateNote,
  createDeleteNote,
} from "./notes";
// match tool removed — usage analytics showed it wasn't being used enough to justify
// the added complexity. The agent should use run_terminal_cmd with rg instead.
// import { createMatch } from "./match";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import type {
  ChatMode,
  ToolContext,
  Todo,
  AnySandbox,
  AppendMetadataStreamFn,
  SubscriptionTier,
  SandboxBootInfo,
  ToolFailureLogger,
  AgentToolApprovalRequester,
  AgentActiveTimeMeasurer,
  SandboxManager,
} from "@/types";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { Geo } from "@vercel/functions";
import { FileAccumulator } from "./utils/file-accumulator";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { ptySessionManager } from "./utils/pty-session-manager";
import { createPtyParserLogBudget } from "./utils/pty-output-formatter";
import { isAwsLambdaMicrovmSandbox, isE2BSandbox } from "./utils/sandbox-types";
import { getSandboxWithFallbackGuard } from "./utils/sandbox-fallback";
import { createE2BResourcePressureObserver } from "@/lib/analytics/sandbox-resource-pressure";
import { E2B_COST_PER_MS } from "./utils/e2b-cost";
import { AWS_LAMBDA_MICROVM_COST_PER_MS } from "./utils/aws-lambda-microvm-cost";
import { AWS_LAMBDA_MICROVM_REGION } from "./utils/aws-lambda-microvm";
import { phLogger } from "@/lib/posthog/server";
import {
  getAwsLambdaMicrovmRolloutTelemetryProperties,
  type AwsLambdaMicrovmRolloutAssignment,
} from "@/lib/experiments/aws-lambda-microvm-rollout";
import type { CloudSandboxAcquisitionContext } from "./utils/cloud-sandbox";
import {
  AlternateCloudSandboxUnavailableError,
  getCloudSandboxRecoveryTelemetryProperties,
} from "./utils/cloud-sandbox-recovery";
import type { CloudSandboxProvider } from "./utils/cloud-sandbox-provider";

export { isE2BSandbox };

export type CreateToolsRuntimePolicy = {
  allowedToolNames?: readonly string[];
  additionalTools?: (context: ToolContext) => ToolSet;
  ptyScopeId?: string;
  chargeSandboxRuntime?: boolean;
  cloudSandboxRollout?: AwsLambdaMicrovmRolloutAssignment;
};

// Factory function to create tools with context
export const createTools = (
  userID: string,
  chatId: string,
  writer: UIMessageStreamWriter,
  mode: ChatMode = "agent",
  userLocation: Geo,
  initialTodos?: Todo[],
  notesEnabled: boolean = true,
  assistantMessageId?: string,
  sandboxPreference?: SandboxPreference,
  serviceKey?: string,
  appendMetadataStream?: AppendMetadataStreamFn,
  onToolCost?: (costDollars: number) => void,
  subscription?: SubscriptionTier,
  onSandboxBoot?: (info: SandboxBootInfo) => void,
  modelName?: string,
  onToolFailure?: ToolFailureLogger,
  requestToolApproval?: AgentToolApprovalRequester,
  autoReviewEvidenceEnabled?: boolean,
  measureAgentActiveTime?: AgentActiveTimeMeasurer,
  workingDirectory?: string,
  triggerRunId?: string,
  auxiliaryVision?: ToolContext["auxiliaryVision"],
  runtimePolicy: CreateToolsRuntimePolicy = {},
) => {
  let sandbox: AnySandbox | null = null;
  let sandboxCostSegmentStartedAt: number | null = null;
  let sandboxAccumulatedCost = 0;
  let sandboxCostPerMs = 0;
  let sandboxCostProvider: CloudSandboxProvider | null = null;
  let providerExposureRecorded = false;
  let sandboxBootInfo: SandboxBootInfo | null = null;
  let currentModelName = modelName;
  let sandboxOperationQueue: Promise<void> = Promise.resolve();
  let pendingSandbox: Promise<AnySandbox> | null = null;

  const recordSandboxBoot = (info: SandboxBootInfo) => {
    sandboxBootInfo = info;
    onSandboxBoot?.(info);
  };

  const cloudSandboxContext: CloudSandboxAcquisitionContext = {
    provider: runtimePolicy.cloudSandboxRollout?.provider,
    subscription,
    chatId,
    triggerRunId,
    rollout: runtimePolicy.cloudSandboxRollout,
    runKind:
      runtimePolicy.chargeSandboxRuntime === false ? "subagent" : "parent",
  };

  const trackSandboxUsage = (newSandbox: AnySandbox) => {
    sandbox = newSandbox;
    const provider = isAwsLambdaMicrovmSandbox(newSandbox)
      ? "aws-lambda-microvm"
      : isE2BSandbox(newSandbox)
        ? "e2b"
        : null;
    if (provider) {
      const now = Date.now();
      const nextCostPerMs =
        provider === "aws-lambda-microvm"
          ? AWS_LAMBDA_MICROVM_COST_PER_MS
          : E2B_COST_PER_MS;
      if (sandboxCostSegmentStartedAt === null) {
        sandboxCostSegmentStartedAt = now;
      } else if (
        sandboxCostProvider !== null &&
        sandboxCostProvider !== provider &&
        sandboxCostSegmentStartedAt !== null
      ) {
        sandboxAccumulatedCost +=
          (now - sandboxCostSegmentStartedAt) * sandboxCostPerMs;
        sandboxCostSegmentStartedAt = now;
      }
      sandboxCostProvider = provider;
      sandboxCostPerMs = nextCostPerMs;
    }
    if (provider && !providerExposureRecorded) {
      providerExposureRecorded = true;
      const rollout = runtimePolicy.cloudSandboxRollout;
      phLogger.event("cloud_sandbox_provider_selected", {
        userId: userID,
        chat_id: chatId,
        trigger_run_id: triggerRunId,
        provider,
        cloud_sandbox_transport:
          provider === "aws-lambda-microvm" ? "aws_websocket" : "e2b_sdk",
        subscription,
        subscription_tier: subscription,
        agent_run_kind: cloudSandboxContext.runKind,
        ...getAwsLambdaMicrovmRolloutTelemetryProperties(rollout),
        ...getCloudSandboxRecoveryTelemetryProperties(cloudSandboxContext),
        sandbox_boot_path: sandboxBootInfo?.path,
        sandbox_acquisition_duration_ms: sandboxBootInfo?.duration_ms,
        sandbox_create_attempts: sandboxBootInfo?.create_attempts,
        region:
          provider === "aws-lambda-microvm"
            ? AWS_LAMBDA_MICROVM_REGION
            : undefined,
        image_version:
          provider === "aws-lambda-microvm"
            ? (process.env.AWS_LAMBDA_MICROVM_IMAGE_VERSION ?? "latest")
            : (process.env.E2B_TEMPLATE ?? "terminal-agent-sandbox"),
        cloud_sandbox_provider_event_version: 3,
      });
    }
  };

  // Cloud protection: free agent users must use a user-owned execution host.
  if (subscription === "free" && isAgentMode(mode)) {
    if (!sandboxPreference || sandboxPreference === "e2b") {
      throw new Error(
        "Free agent mode requires a local sandbox. Cloud sandboxes are not available on the free plan.",
      );
    }
  }

  // Use HybridSandboxManager if sandboxPreference and serviceKey are provided
  const sandboxManager: SandboxManager =
    sandboxPreference && serviceKey
      ? new HybridSandboxManager(
          userID,
          trackSandboxUsage,
          sandboxPreference,
          serviceKey,
          isE2BSandbox(sandbox) ? sandbox : null,
          subscription,
          recordSandboxBoot,
          workingDirectory,
          triggerRunId,
          chatId,
          cloudSandboxContext,
        )
      : new DefaultSandboxManager(
          userID,
          trackSandboxUsage,
          isE2BSandbox(sandbox) ? sandbox : null,
          recordSandboxBoot,
          cloudSandboxContext,
        );

  const todoManager = new TodoManager(initialTodos);
  const fileAccumulator = new FileAccumulator();
  const backgroundProcessTracker = new BackgroundProcessTracker();
  const onSandboxResourceMetrics = createE2BResourcePressureObserver({
    userId: userID,
    chatId,
    ptyScopeId: runtimePolicy.ptyScopeId,
    mode,
    subscription,
    triggerRunId,
  });

  const context: ToolContext = {
    sandboxManager,
    writer,
    userLocation,
    todoManager,
    userID,
    chatId,
    ptyScopeId: runtimePolicy.ptyScopeId,
    assistantMessageId,
    triggerRunId,
    fileAccumulator,
    backgroundProcessTracker,
    ptySessionManager,
    ptyParserLogBudget: createPtyParserLogBudget(),
    mode,
    modelName,
    getCurrentModelName: () => currentModelName,
    subscription,
    isE2BSandbox,
    appendMetadataStream,
    onToolCost,
    onToolFailure,
    requestToolApproval,
    autoReviewEvidenceEnabled,
    measureAgentActiveTime,
    onSandboxResourceMetrics,
    auxiliaryVision,
  };

  const buildTools = (): ToolSet => {
    // Create all available tools. This is intentionally a factory rather than a
    // one-time object so model-specific tool schemas can be rebuilt for
    // provider fallback legs.
    const allTools = {
      run_terminal_cmd: createRunTerminalCmd(context),
      interact_terminal_session: createInteractTerminalSession(context),
      get_terminal_files: createGetTerminalFiles(context),
      file: createFile(context),
      todo_write: createTodoWrite(context),
      ...(notesEnabled && {
        create_note: createCreateNote(context),
        list_notes: createListNotes(context),
        update_note: createUpdateNote(context),
        delete_note: createDeleteNote(context),
      }),
      ...(process.env.PERPLEXITY_API_KEY && {
        web_search: createWebSearch(context),
      }),
      ...(process.env.JINA_API_KEY && {
        open_url: createOpenUrlTool(context),
      }),
      ...(runtimePolicy.additionalTools?.(context) ?? {}),
    };

    if (runtimePolicy.allowedToolNames) {
      const allowed = new Set(runtimePolicy.allowedToolNames);
      return Object.fromEntries(
        Object.entries(allTools).filter(([name]) => allowed.has(name)),
      ) as ToolSet;
    }

    // Filter tools based on mode
    return mode === "ask"
      ? {
          ...(notesEnabled && {
            create_note: allTools.create_note,
            list_notes: allTools.list_notes,
            update_note: allTools.update_note,
            delete_note: allTools.delete_note,
          }),
          ...(process.env.PERPLEXITY_API_KEY && {
            web_search: createWebSearch(context),
          }),
          ...(process.env.JINA_API_KEY && {
            open_url: createOpenUrlTool(context),
          }),
        }
      : allTools;
  };

  const tools = buildTools();

  const getSandbox = () => sandbox;
  const ensureSandbox = async (options?: {
    refresh?: boolean;
    reason?: string;
    excludeConnectionId?: string;
    requireAlternateCloudProvider?: boolean;
  }) => {
    const recoveryRequested = Boolean(
      options?.refresh ||
      options?.excludeConnectionId ||
      options?.requireAlternateCloudProvider,
    );
    if (!recoveryRequested && pendingSandbox) return pendingSandbox;

    const operation = sandboxOperationQueue.then(async () => {
      if (options?.excludeConnectionId) {
        // Serialize quarantine/reset with every acquisition so a promise that
        // began before recovery cannot repopulate the manager afterward.
        await sandboxManager.quarantineLocalConnection?.(
          options.excludeConnectionId,
          "command_unresponsive",
        );
      }
      if (options?.requireAlternateCloudProvider) {
        const alternateProvider =
          sandboxManager.selectAlternateCloudProviderForRecovery?.() ?? null;
        if (!alternateProvider) {
          throw new AlternateCloudSandboxUnavailableError();
        }
      }
      if (options?.refresh) {
        await sandboxManager.resetSandbox?.(options.reason);
      }
      const { sandbox: ensured } = await getSandboxWithFallbackGuard({
        sandboxManager,
      });
      return ensured;
    });
    sandboxOperationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    pendingSandbox = operation;
    void operation.then(
      () => {
        if (pendingSandbox === operation) pendingSandbox = null;
      },
      () => {
        if (pendingSandbox === operation) pendingSandbox = null;
      },
    );
    return operation;
  };
  const getTodoManager = () => todoManager;
  const getFileAccumulator = () => fileAccumulator;
  const setCurrentModelName = (nextModelName: string | undefined) => {
    currentModelName = nextModelName;
  };

  const getToolsForModel = (nextModelName: string | undefined) => {
    setCurrentModelName(nextModelName);
    return buildTools();
  };

  const getSandboxSessionCost = (): number => {
    if (runtimePolicy.chargeSandboxRuntime === false) return 0;
    if (sandboxCostSegmentStartedAt === null) return 0;
    return (
      sandboxAccumulatedCost +
      (Date.now() - sandboxCostSegmentStartedAt) * sandboxCostPerMs
    );
  };

  return {
    tools,
    getSandbox,
    ensureSandbox,
    getTodoManager,
    getFileAccumulator,
    sandboxManager,
    getSandboxSessionCost,
    setCurrentModelName,
    getToolsForModel,
  };
};

// Re-export types for external use
export type { SandboxPreference };
