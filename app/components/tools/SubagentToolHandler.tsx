"use client";

import { memo, useMemo, type ComponentType } from "react";
import {
  Asterisk,
  Atom,
  Bot,
  Flower2,
  Hexagon,
  Orbit,
  Sparkles,
  type LucideProps,
} from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarSubagents } from "@/types/chat";
import { isSidebarSubagents } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";
import { formatSubagentCountSummary } from "@/lib/ai/subagents/status-summary";

type LifecyclePart = {
  type: "data-subagent-lifecycle";
  data?: {
    subagent_id?: string;
    parent_message_id?: string;
    parent_tool_call_id?: string;
    agent_name?: string;
    status?: string;
  };
};

type SubagentPresentation = {
  action: string;
  agentId?: string;
  agentName: string;
  canOpenSidebar: boolean;
  parentMessageId: string;
  showAsChip: boolean;
  sidebarContent: SidebarSubagents;
  suffix?: string;
  toolCallId: string;
  waiting: boolean;
};

type SubagentVisual = {
  Icon: ComponentType<LucideProps>;
  iconClassName: string;
  iconSurfaceClassName: string;
};

const SUBAGENT_VISUALS: readonly SubagentVisual[] = [
  {
    Icon: Flower2,
    iconClassName: "text-pink-400",
    iconSurfaceClassName: "bg-pink-500/15",
  },
  {
    Icon: Orbit,
    iconClassName: "text-cyan-400",
    iconSurfaceClassName: "bg-cyan-500/15",
  },
  {
    Icon: Sparkles,
    iconClassName: "text-amber-400",
    iconSurfaceClassName: "bg-amber-500/15",
  },
  {
    Icon: Atom,
    iconClassName: "text-violet-400",
    iconSurfaceClassName: "bg-violet-500/15",
  },
  {
    Icon: Asterisk,
    iconClassName: "text-emerald-400",
    iconSurfaceClassName: "bg-emerald-500/15",
  },
  {
    Icon: Hexagon,
    iconClassName: "text-orange-400",
    iconSurfaceClassName: "bg-orange-500/15",
  },
] as const;

const nameForAgentId = (
  message: UIMessage,
  agentId: string | undefined,
): string | undefined => {
  if (!agentId) return undefined;
  for (const candidate of message.parts as any[]) {
    if (
      candidate?.type === "data-subagent-lifecycle" &&
      candidate?.data?.subagent_id === agentId &&
      candidate?.data?.agent_name
    ) {
      return candidate.data.agent_name;
    }
    if (
      (candidate?.type === "tool-create_agent" ||
        candidate?.type === "tool-delegate_task") &&
      candidate?.output?.agent_id === agentId &&
      candidate?.output?.name
    ) {
      return candidate.output.name;
    }
  }
  return undefined;
};

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
};

const assignVisualIndexes = (presentations: SubagentPresentation[]) => {
  const occupied = new Set<number>();
  return presentations.map(({ agentId, toolCallId }) => {
    const preferredIndex =
      hashString(agentId ?? toolCallId) % SUBAGENT_VISUALS.length;
    for (let offset = 0; offset < SUBAGENT_VISUALS.length; offset += 1) {
      const visualIndex = (preferredIndex + offset) % SUBAGENT_VISUALS.length;
      if (occupied.has(visualIndex)) continue;
      occupied.add(visualIndex);
      return visualIndex;
    }
    return preferredIndex;
  });
};

const useStableSubagentSidebarContent = (
  content: SidebarSubagents,
): SidebarSubagents => {
  const { parentMessageId, selectedSubagentId, toolCallId } = content;
  return useMemo(
    () => ({
      kind: "subagents",
      parentMessageId,
      toolCallId,
      ...(selectedSubagentId ? { selectedSubagentId } : {}),
    }),
    [parentMessageId, selectedSubagentId, toolCallId],
  );
};

const presentationForPart = (
  message: UIMessage,
  part: any,
  status: ChatStatus,
): SubagentPresentation => {
  const { toolCallId, state, input, output, errorText, type } = part;
  const targetAgentIds = Array.isArray(input?.target_agent_ids)
    ? input.target_agent_ids.filter(
        (candidate: unknown): candidate is string =>
          typeof candidate === "string" && candidate.length > 0,
      )
    : [];
  const singleTargetAgentId =
    targetAgentIds.length === 1 ? targetAgentIds[0] : undefined;
  const lifecycle = (message.parts as any[]).find(
    (candidate: any) =>
      candidate?.type === "data-subagent-lifecycle" &&
      candidate?.data?.parent_tool_call_id === toolCallId,
  ) as LifecyclePart | undefined;
  const agentId =
    lifecycle?.data?.subagent_id ??
    output?.agent_id ??
    output?.target_agent_id ??
    input?.target_agent_id ??
    singleTargetAgentId;
  const legacyTitle =
    input?.profile_input?.candidate?.title ??
    input?.objective ??
    "Delegated task";
  const agentName =
    lifecycle?.data?.agent_name ??
    output?.name ??
    output?.target_agent_name ??
    output?.agent_name ??
    input?.name ??
    nameForAgentId(message, agentId) ??
    (type === "tool-cancel_agent" ? agentId : undefined) ??
    (type === "tool-delegate_task"
      ? legacyTitle
      : type === "tool-list_agents"
        ? "Subagents"
        : "Subagent");
  const parentMessageId = lifecycle?.data?.parent_message_id ?? message.id;
  const isLegacy =
    type === "tool-delegate_task" && input?.profile_input !== undefined;
  const isCreate =
    type === "tool-create_agent" ||
    (type === "tool-delegate_task" && !isLegacy);
  const isContinue = type === "tool-continue_agent";
  const isList = type === "tool-list_agents";
  const isSend = type === "tool-send_message_to_agent";
  const isWait = type === "tool-wait_for_agents";
  const isCancel = type === "tool-cancel_agent";
  const hasChildLifecycle = Boolean(lifecycle?.data?.subagent_id);
  const failed = Boolean(errorText) || output?.success === false;
  const legacyCanOpen =
    !errorText && (output?.status !== "failed" || hasChildLifecycle);
  const canOpenSidebar =
    state !== "input-streaming" &&
    (isLegacy
      ? legacyCanOpen
      : hasChildLifecycle ||
        (isCreate && output?.success === true) ||
        (isList && output?.success === true) ||
        ((isSend || isWait || isCancel || isContinue) &&
          output?.success === true &&
          agentId));
  const waiting =
    state === "input-streaming" ||
    (state === "input-available" && status === "streaming");

  let action: string;
  let suffix: string | undefined;
  let showAsChip = false;
  if (isCreate) {
    suffix = failed
      ? "failed to start"
      : waiting
        ? "starting"
        : "started working";
    action = `${agentName} ${suffix}`;
    showAsChip = true;
  } else if (isContinue) {
    suffix = failed ? "resume failed" : waiting ? "resuming" : "resumed";
    action = `${agentName} ${suffix}`;
    showAsChip = true;
  } else if (isList) {
    action = waiting
      ? "Checking subagents"
      : failed
        ? "Could not list subagents"
        : formatSubagentCountSummary(output?.agents);
  } else if (isSend) {
    suffix = failed ? "update failed" : waiting ? "updating" : "updated";
    action = `${agentName} ${suffix}`;
    showAsChip = true;
  } else if (isWait) {
    const terminalStatus = output?.result?.status ?? lifecycle?.data?.status;
    if (waiting) {
      const singleTargetAgentName = nameForAgentId(
        message,
        singleTargetAgentId,
      );
      action = singleTargetAgentName
        ? `Waiting for ${singleTargetAgentName}`
        : singleTargetAgentId
          ? "Waiting for subagent"
          : "Waiting for subagents";
    } else if (output?.wait_outcome === "progress") {
      action = "Subagent progress received";
    } else if (output?.wait_outcome === "targets_not_found") {
      action = "Subagent targets not found";
    } else if (output?.wait_outcome === "timeout") {
      action = "Subagent wait timed out";
    } else if (output?.wait_outcome === "no_active_agents") {
      action = "No active subagents";
    } else {
      suffix =
        terminalStatus && terminalStatus !== "completed"
          ? terminalStatus.replaceAll("_", " ")
          : "finished";
      action = `${agentName} ${suffix}`;
      showAsChip = Boolean(agentId);
    }
  } else if (isCancel) {
    suffix = failed ? "cancel failed" : waiting ? "canceling" : "canceled";
    action = `${agentName} ${suffix}`;
    showAsChip = true;
  } else {
    action =
      output?.status && output.status !== "completed"
        ? `${agentName} failed`
        : output?.status === "completed"
          ? `${agentName} completed`
          : waiting
            ? `${agentName} working`
            : errorText
              ? `${agentName} failed`
              : agentName;
  }

  return {
    action,
    agentId,
    agentName,
    canOpenSidebar,
    parentMessageId,
    showAsChip,
    sidebarContent: {
      kind: "subagents",
      parentMessageId,
      toolCallId,
      ...(!isLegacy && !isList && agentId
        ? { selectedSubagentId: agentId }
        : {}),
    },
    suffix,
    toolCallId,
    waiting,
  };
};

const SubagentChip = ({
  presentation,
  visualIndex,
}: {
  presentation: SubagentPresentation;
  visualIndex: number;
}) => {
  const { agentName, canOpenSidebar, toolCallId, waiting } = presentation;
  const sidebarContent = useStableSubagentSidebarContent(
    presentation.sidebarContent,
  );
  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarSubagents,
  });
  const visual = SUBAGENT_VISUALS[visualIndex];
  const label = waiting ? <Shimmer>{agentName}</Shimmer> : agentName;
  const className =
    "not-prose inline-flex h-9 min-w-0 max-w-64 items-center gap-2 rounded-full border border-border bg-muted/20 px-3 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
  const content = (
    <>
      <span
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${visual.iconSurfaceClassName}`}
        aria-hidden="true"
      >
        <visual.Icon className={`size-3.5 ${visual.iconClassName}`} />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </>
  );

  if (!canOpenSidebar) {
    return (
      <span
        className={className}
        data-subagent-visual={visualIndex}
        title={agentName}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`${className} cursor-pointer hover:bg-muted/40`}
      data-subagent-visual={visualIndex}
      onClick={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
      aria-label={`Open ${agentName} in sidebar`}
      title={agentName}
    >
      {content}
    </button>
  );
};

const SubagentFallback = ({
  presentation,
}: {
  presentation: SubagentPresentation;
}) => {
  const sidebarContent = useStableSubagentSidebarContent(
    presentation.sidebarContent,
  );
  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId: presentation.toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarSubagents,
  });

  return (
    <ToolBlock
      icon={<Bot aria-hidden="true" />}
      action={presentation.action}
      isShimmer={presentation.waiting}
      isClickable={Boolean(presentation.canOpenSidebar)}
      onClick={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
      accessibleLabel={
        presentation.canOpenSidebar
          ? `Open ${presentation.agentName} in sidebar`
          : presentation.action
      }
    />
  );
};

export const SubagentToolGroup = memo(function SubagentToolGroup({
  message,
  parts,
  status,
}: {
  message: UIMessage;
  parts: any[];
  status: ChatStatus;
}) {
  const presentations = parts.map((part) =>
    presentationForPart(message, part, status),
  );
  const sharedSuffix = presentations[0]?.suffix;
  const canShareRow =
    presentations.length > 0 &&
    Boolean(sharedSuffix) &&
    presentations.every(
      (presentation) =>
        presentation.showAsChip && presentation.suffix === sharedSuffix,
    );

  if (!canShareRow) {
    return (
      <div className="space-y-3">
        {parts.map((part) => (
          <SubagentToolHandler
            key={part.toolCallId}
            message={message}
            part={part}
            status={status}
          />
        ))}
      </div>
    );
  }

  const visualIndexes = assignVisualIndexes(presentations);
  return (
    <div
      className="not-prose flex min-w-0 flex-wrap items-center gap-2"
      role="group"
      aria-label={`${presentations.map(({ agentName }) => agentName).join(", ")} ${sharedSuffix}`}
    >
      {presentations.map((presentation, index) => (
        <SubagentChip
          key={presentation.toolCallId}
          presentation={presentation}
          visualIndex={visualIndexes[index]}
        />
      ))}
      <span className="text-[13px] text-muted-foreground">{sharedSuffix}</span>
    </div>
  );
});

export const SubagentToolHandler = memo(function SubagentToolHandler({
  message,
  part,
  status,
}: {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}) {
  const presentation = presentationForPart(message, part, status);
  if (presentation.showAsChip && presentation.suffix) {
    return (
      <SubagentToolGroup message={message} parts={[part]} status={status} />
    );
  }
  return <SubagentFallback presentation={presentation} />;
});
