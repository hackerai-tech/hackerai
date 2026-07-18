"use client";

import { memo, useMemo } from "react";
import { useQuery } from "convex/react";
import { ShieldAlert } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { ChatStatus, SidebarFinding } from "@/types/chat";
import type { FindingDetailRecord } from "@/types/finding";
import { isSidebarFinding } from "@/types/chat";
import ToolBlock from "@/components/ui/tool-block";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { FindingCard } from "@/app/components/findings/FindingCard";
import {
  ToolErrorHandler,
  ToolValidationErrorHandler,
} from "./ToolErrorHandler";
import {
  createFindingFailureContent,
  isToolInputValidationError,
} from "@/lib/chat/tool-error-display";

type FindingOutput = {
  success?: boolean;
  finding_id?: string;
  title?: string;
  target?: string;
  endpoint?: string;
  severity?: SidebarFinding["severity"];
  cvss_score?: number;
  error?: "validation" | "duplicate" | "chat_not_found" | "general";
  message?: string;
};

const failureAction = (output: FindingOutput) => {
  if (output.error === "duplicate") return "Duplicate finding rejected";
  return "Finding was not saved";
};

const SavedFindingCard = ({
  output,
  toolCallId,
}: {
  output: Required<
    Pick<
      FindingOutput,
      "finding_id" | "title" | "target" | "severity" | "cvss_score"
    >
  > &
    Pick<FindingOutput, "endpoint">;
  toolCallId: string;
}) => {
  const finding = useQuery(api.findings.getFinding, {
    findingId: output.finding_id,
  }) as FindingDetailRecord | null | undefined;

  const content = useMemo<SidebarFinding>(
    () => ({
      findingId: output.finding_id,
      title: finding?.title ?? output.title,
      target: finding?.target ?? output.target,
      endpoint: finding?.endpoint ?? output.endpoint,
      severity: finding?.severity ?? output.severity,
      cvssScore: finding?.cvss_score ?? output.cvss_score,
      isExecuting: false,
      toolCallId,
    }),
    [finding, output, toolCallId],
  );
  const { handleOpenInSidebar } = useToolSidebar({
    toolCallId,
    content,
    typeGuard: isSidebarFinding,
  });

  if (finding === null) {
    return (
      <ToolBlock
        icon={<ShieldAlert aria-hidden="true" />}
        action="Finding deleted"
        target={output.title}
      />
    );
  }

  const handleOpen = () => {
    captureAuthenticatedEvent("finding_viewed", { surface: "inline_card" });
    handleOpenInSidebar();
  };

  return (
    <FindingCard
      title={content.title}
      target={content.endpoint || content.target}
      severity={content.severity}
      cvssScore={content.cvssScore}
      onClick={handleOpen}
    />
  );
};

export const FindingToolHandler = memo(function FindingToolHandler({
  part,
  status,
}: {
  part: any;
  status: ChatStatus;
}) {
  const { toolCallId = "", state, input, output, errorText } = part;
  const result = (output?.result ?? output ?? {}) as FindingOutput;
  const target = input?.title || input?.target;

  if (state === "input-streaming") {
    return status === "streaming" ? (
      <ToolBlock
        icon={<ShieldAlert aria-hidden="true" />}
        action="Preparing vulnerability report"
        isShimmer={true}
      />
    ) : null;
  }

  if (state === "input-available") {
    return status === "streaming" ? (
      <ToolBlock
        icon={<ShieldAlert aria-hidden="true" />}
        action="Saving confirmed finding"
        target={target}
        isShimmer={true}
      />
    ) : null;
  }

  if (state === "output-error") {
    return isToolInputValidationError(errorText) ? (
      <ToolValidationErrorHandler
        toolType="tool-create_vulnerability_report"
        toolCallId={toolCallId}
        errorText={errorText}
      />
    ) : (
      <ToolErrorHandler
        content={createFindingFailureContent({
          toolCallId,
          reason: "general",
        })}
      />
    );
  }

  if (state === "output-available") {
    if (result.success === false) {
      if (result.error !== "duplicate") {
        return (
          <ToolErrorHandler
            content={createFindingFailureContent({
              toolCallId,
              reason:
                result.error === "validation" ||
                result.error === "chat_not_found"
                  ? result.error
                  : "general",
            })}
          />
        );
      }

      return (
        <ToolBlock
          icon={<ShieldAlert aria-hidden="true" />}
          action={failureAction(result)}
          target={result.message}
        />
      );
    }

    if (
      result.success === true &&
      result.finding_id &&
      result.title &&
      result.target &&
      result.severity &&
      typeof result.cvss_score === "number"
    ) {
      return (
        <SavedFindingCard
          output={{
            finding_id: result.finding_id,
            title: result.title,
            target: result.target,
            endpoint: result.endpoint,
            severity: result.severity,
            cvss_score: result.cvss_score,
          }}
          toolCallId={toolCallId}
        />
      );
    }

    return (
      <ToolErrorHandler
        content={createFindingFailureContent({
          toolCallId,
          reason: "invalid_result",
        })}
      />
    );
  }

  return null;
});
