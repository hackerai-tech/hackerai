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
import {
  getCloudSandboxProviderForInstance,
  isE2BSandbox,
  isMiosaSandbox,
} from "./utils/sandbox-types";
import { getSandboxWithFallbackGuard } from "./utils/sandbox-fallback";
import { createE2BResourcePressureObserver } from "@/lib/analytics/sandbox-resource-pressure";
import { E2B_COST_PER_MS } from "./utils/e2b-cost";
import { phLogger } from "@/lib/posthog/server";
import { logger } from "@/lib/logger";
import { redactSensitiveErrorMessage } from "@/lib/utils/error-redaction";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import type { CloudSandboxAcquisitionContext } from "./utils/cloud-sandbox";
import type {
  CloudSandboxProvider,
  CloudSandboxSelectionReason,
} from "./utils/cloud-sandbox-provider";

export { isE2BSandbox };

export type CreateToolsRuntimePolicy = {
  allowedToolNames?: readonly string[];
  additionalTools?: (context: ToolContext) => ToolSet;
  ptyScopeId?: string;
  chargeSandboxRuntime?: boolean;
  cloudSandboxProvider?: CloudSandboxProvider;
  cloudSandboxSelectionReason?: CloudSandboxSelectionReason;
  triggerRegion?: TriggerRunRegion;
};

export type SandboxSessionUsage = {
  totalCostDollars: number;
  miosaRuntimeMs: number;
  miosaCostDollars: number;
  e2bRuntimeMs: number;
  e2bCostDollars: number;
};

const emptySandboxRuntimeMs = (): Record<CloudSandboxProvider, number> => ({
  miosa: 0,
  e2b: 0,
});
const MIOSA_USAGE_READ_TIMEOUT_MS = 2_000;
const MIOSA_USAGE_CACHE_TTL_MS = 1_000;

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
  let sandboxCostProvider: CloudSandboxProvider | null = null;
  const sandboxAccumulatedRuntimeMs = emptySandboxRuntimeMs();
  let providerSelectionRecorded = false;
  let sandboxBootInfo: SandboxBootInfo | null = null;
  let currentModelName = modelName;
  let sandboxOperationQueue: Promise<void> = Promise.resolve();
  let pendingSandbox: Promise<AnySandbox> | null = null;
  type MiosaSandboxInstance = Extract<AnySandbox, { sandboxKind: "miosa" }>;
  type MiosaCostSource = {
    sandbox: MiosaSandboxInstance;
    baselinePromise: Promise<number | null>;
    latestCostDollars: number;
  };
  const miosaCostSources = new Map<string, MiosaCostSource>();
  const miosaUsageReads = new Map<string, Promise<number | null>>();
  let cachedMiosaCostSettlement: {
    settledAt: number;
    totalCostDollars: number;
  } | null = null;

  const readMiosaCostDollars = async (
    miosaSandbox: MiosaSandboxInstance,
  ): Promise<number | null> => {
    const sandboxId = miosaSandbox.sandboxId;
    let providerRead = miosaUsageReads.get(sandboxId);
    if (!providerRead) {
      providerRead = miosaSandbox.sdkSandbox
        .usage()
        .then((usage) => usage.estimated_cost_cents / 100)
        .catch((error) => {
          logger.warn("MIOSA usage read failed", {
            event: "miosa_usage_read_failed",
            service: "agent-tools",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            request_id: triggerRunId ?? chatId,
            chat_id: chatId,
            sandbox_id: sandboxId,
            provider: "miosa",
            error:
              error instanceof Error
                ? redactSensitiveErrorMessage(error.message)
                : "non_error_rejection",
          });
          return null;
        });
      miosaUsageReads.set(sandboxId, providerRead);
      void providerRead.then(() => {
        if (miosaUsageReads.get(sandboxId) === providerRead) {
          miosaUsageReads.delete(sandboxId);
        }
      });
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        providerRead,
        new Promise<null>((resolve) => {
          timeout = setTimeout(
            () => resolve(null),
            MIOSA_USAGE_READ_TIMEOUT_MS,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const recordSandboxBoot = (info: SandboxBootInfo) => {
    sandboxBootInfo = info;
    onSandboxBoot?.(info);
  };

  const cloudSandboxContext: CloudSandboxAcquisitionContext = {
    provider: runtimePolicy.cloudSandboxProvider,
    selectionReason: runtimePolicy.cloudSandboxSelectionReason,
    subscription,
    chatId,
    triggerRunId,
    triggerRegion: runtimePolicy.triggerRegion,
    runKind:
      runtimePolicy.chargeSandboxRuntime === false ? "subagent" : "parent",
  };

  const trackSandboxUsage = (newSandbox: AnySandbox) => {
    sandbox = newSandbox;
    const provider = getCloudSandboxProviderForInstance(newSandbox);
    if (isMiosaSandbox(newSandbox)) {
      const existingSource = miosaCostSources.get(newSandbox.sandboxId);
      if (existingSource) {
        existingSource.sandbox = newSandbox;
      } else {
        miosaCostSources.set(newSandbox.sandboxId, {
          sandbox: newSandbox,
          baselinePromise: readMiosaCostDollars(newSandbox),
          latestCostDollars: 0,
        });
        cachedMiosaCostSettlement = null;
      }
    }
    const now = Date.now();
    if (
      sandboxCostSegmentStartedAt !== null &&
      sandboxCostProvider !== null &&
      sandboxCostProvider !== provider
    ) {
      sandboxAccumulatedRuntimeMs[sandboxCostProvider] +=
        now - sandboxCostSegmentStartedAt;
      sandboxCostSegmentStartedAt = null;
    }
    if (provider !== null && sandboxCostSegmentStartedAt === null) {
      sandboxCostSegmentStartedAt = now;
    }
    sandboxCostProvider = provider;
    if (provider && !providerSelectionRecorded) {
      providerSelectionRecorded = true;
      phLogger.event("cloud_sandbox_provider_selected", {
        userId: userID,
        chat_id: chatId,
        trigger_run_id: triggerRunId,
        provider,
        provider_selection_reason:
          provider === runtimePolicy.cloudSandboxProvider
            ? (runtimePolicy.cloudSandboxSelectionReason ?? "configured")
            : "provider_fallback",
        cloud_sandbox_transport: provider === "miosa" ? "miosa_sdk" : "e2b_sdk",
        subscription,
        subscription_tier: subscription,
        agent_run_kind: cloudSandboxContext.runKind,
        sandbox_boot_path: sandboxBootInfo?.path,
        sandbox_acquisition_duration_ms: sandboxBootInfo?.duration_ms,
        sandbox_create_attempts: sandboxBootInfo?.create_attempts,
        image_version:
          provider === "miosa"
            ? process.env.MIOSA_TEMPLATE_ID
            : (process.env.E2B_TEMPLATE ?? "terminal-agent-sandbox"),
        cloud_sandbox_provider_event_version: 7,
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
  }) => {
    const recoveryRequested = Boolean(
      options?.refresh || options?.excludeConnectionId,
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

  const settleMiosaCostDollars = async (
    forceFresh = false,
  ): Promise<number> => {
    const now = Date.now();
    if (
      !forceFresh &&
      cachedMiosaCostSettlement &&
      now - cachedMiosaCostSettlement.settledAt < MIOSA_USAGE_CACHE_TTL_MS
    ) {
      return cachedMiosaCostSettlement.totalCostDollars;
    }

    let cacheable = true;
    await Promise.all(
      [...miosaCostSources.values()].map(async (source) => {
        const baseline = await source.baselinePromise;
        if (baseline === null) {
          cacheable = false;
          source.baselinePromise = readMiosaCostDollars(source.sandbox);
          return;
        }
        const current = await readMiosaCostDollars(source.sandbox);
        if (current !== null) {
          source.latestCostDollars = Math.max(
            source.latestCostDollars,
            current - baseline,
          );
        } else {
          cacheable = false;
        }
      }),
    );
    const totalCostDollars = [...miosaCostSources.values()].reduce(
      (total, source) => total + source.latestCostDollars,
      0,
    );
    if (cacheable) {
      cachedMiosaCostSettlement = {
        settledAt: Date.now(),
        totalCostDollars,
      };
    }
    return totalCostDollars;
  };

  const getSandboxSessionUsage = async (): Promise<SandboxSessionUsage> => {
    if (runtimePolicy.chargeSandboxRuntime === false) {
      return {
        totalCostDollars: 0,
        miosaRuntimeMs: 0,
        miosaCostDollars: 0,
        e2bRuntimeMs: 0,
        e2bCostDollars: 0,
      };
    }

    const runtimeMs = { ...sandboxAccumulatedRuntimeMs };
    if (sandboxCostSegmentStartedAt !== null && sandboxCostProvider !== null) {
      runtimeMs[sandboxCostProvider] +=
        Date.now() - sandboxCostSegmentStartedAt;
    }
    const e2bCostDollars = runtimeMs.e2b * E2B_COST_PER_MS;
    const miosaCostDollars = await settleMiosaCostDollars(true);
    return {
      totalCostDollars: e2bCostDollars + miosaCostDollars,
      miosaRuntimeMs: runtimeMs.miosa,
      miosaCostDollars,
      e2bRuntimeMs: runtimeMs.e2b,
      e2bCostDollars,
    };
  };

  const getSandboxSessionCost = async (): Promise<number> => {
    if (runtimePolicy.chargeSandboxRuntime === false) return 0;
    let e2bRuntimeMs = sandboxAccumulatedRuntimeMs.e2b;
    if (sandboxCostSegmentStartedAt !== null && sandboxCostProvider === "e2b") {
      e2bRuntimeMs += Date.now() - sandboxCostSegmentStartedAt;
    }
    const miosaCostDollars = await settleMiosaCostDollars();
    return e2bRuntimeMs * E2B_COST_PER_MS + miosaCostDollars;
  };

  return {
    tools,
    getSandbox,
    ensureSandbox,
    getTodoManager,
    getFileAccumulator,
    sandboxManager,
    getSandboxSessionCost,
    getSandboxSessionUsage,
    setCurrentModelName,
    getToolsForModel,
  };
};

// Re-export types for external use
export type { SandboxPreference };
