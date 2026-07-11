"use client";

import { useCallback, useEffect } from "react";
import { ChevronDown, Hand, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  type ActiveAgentToolApprovalRequest,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deriveAgentApprovalTargetGrant } from "@/lib/chat/agent-approval-grants";

type AgentApprovalPromptProps = {
  request: ActiveAgentToolApprovalRequest;
};

const isPlainEnterKey = (event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  event.key === "Enter" &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

const isEditableKeyTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const editableElement = target.closest("input, textarea, select");
  if (!editableElement) return false;

  if (editableElement instanceof HTMLInputElement) {
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(editableElement.type);
  }

  return true;
};

const getApprovalCategory = (request: ActiveAgentToolApprovalRequest) => {
  if (request.operation === "terminal_execute") return "Terminal command";
  if (request.operation === "terminal_interact") return "Terminal access";
  if (request.kind === "file") return "File change";
  return request.kind === "terminal" ? "Terminal command" : "Agent action";
};

const getReusableApprovalDescription = (
  grant: NonNullable<ReturnType<typeof deriveAgentApprovalTargetGrant>>,
): string => {
  if (grant.kind === "terminal_command") {
    return `Commands starting with ${grant.argv.join(" ")}`;
  }
  if (grant.kind === "terminal_interaction") {
    return `${grant.action} actions in this terminal session`;
  }
  return `Changes to ${grant.path}`;
};

export function AgentApprovalPrompt({ request }: AgentApprovalPromptProps) {
  const { session, sendToolApproval, toolApprovalSendStates } =
    useAgentApproval();
  const sendState = toolApprovalSendStates[request.approvalId] ?? "idle";
  const isSending = sendState === "sending";
  const isApproved = sendState === "approved";
  const isDenied = sendState === "denied";
  const isSettled = isApproved || isDenied;
  const canSubmit = !!session && !isSending && !isSettled;
  const targetGrant = deriveAgentApprovalTargetGrant(request);
  const reusableApprovalLabel =
    targetGrant?.kind === "terminal_interaction"
      ? "Allow for this run"
      : "Allow this conversation";
  const reusableApprovalDescription = targetGrant
    ? getReusableApprovalDescription(targetGrant)
    : "";
  const approvalTarget = request.target?.trim() ?? "";
  const justification =
    request.justification?.trim() || request.detail?.trim() || "";

  const submitApproval = useCallback(
    async (reuseForConversation: boolean) => {
      if (!canSubmit) return;
      try {
        await sendToolApproval({
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          decision: "approve",
          ...(reuseForConversation && targetGrant
            ? {
                grant: "target_prefix",
                targetPrefix: targetGrant.targetPrefix,
                targetKind: targetGrant.kind,
              }
            : {}),
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to send approval response.",
        );
      }
    },
    [
      canSubmit,
      request.approvalId,
      request.toolCallId,
      sendToolApproval,
      targetGrant,
    ],
  );

  const denyApproval = useCallback(async () => {
    if (!canSubmit) return;
    try {
      await sendToolApproval({
        approvalId: request.approvalId,
        toolCallId: request.toolCallId,
        decision: "deny",
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to send approval response.",
      );
    }
  }, [canSubmit, request.approvalId, request.toolCallId, sendToolApproval]);

  useEffect(() => {
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!canSubmit || event.defaultPrevented || !isPlainEnterKey(event)) {
        return;
      }
      if (isEditableKeyTarget(event.target)) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("button, [role='menu']")
      ) {
        return;
      }

      event.preventDefault();
      void submitApproval(false);
    };

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [canSubmit, submitApproval]);

  const allowLabel = isSending
    ? "Approving"
    : isApproved
      ? "Approved"
      : isDenied
        ? "Denied"
        : "Allow once";

  return (
    <form
      className="order-2 flex min-w-0 flex-col gap-4 rounded-[22px] border border-black/8 bg-input-chat px-4 py-4 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] dark:border-border sm:order-1 sm:px-5 sm:py-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submitApproval(false);
      }}
      data-testid="agent-approval-prompt"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Hand className="size-4" aria-hidden="true" />
        <span>{getApprovalCategory(request)}</span>
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="text-[15px] font-medium leading-5 text-foreground sm:text-base">
          {request.title}
        </div>
        {justification ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {justification}
          </p>
        ) : null}
      </div>

      {approvalTarget ? (
        <div className="max-h-24 overflow-auto rounded-lg bg-black/5 px-3 py-2 font-mono text-sm leading-5 text-muted-foreground dark:bg-white/5">
          {request.target}
        </div>
      ) : null}

      <div
        className="flex items-center justify-end gap-2"
        data-testid="agent-approval-actions"
      >
        <Button
          type="button"
          variant="outline"
          disabled={!canSubmit}
          className="rounded-full bg-transparent shadow-none"
          onClick={() => void denyApproval()}
        >
          Deny
        </Button>

        <div className="flex items-center">
          <Button
            type="submit"
            disabled={!canSubmit}
            className={
              targetGrant
                ? "rounded-l-full rounded-r-none px-4"
                : "rounded-full px-4"
            }
          >
            {isSending ? <Loader2 className="animate-spin" /> : null}
            {allowLabel}
          </Button>

          {targetGrant ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  disabled={!canSubmit}
                  className="rounded-l-none rounded-r-full border-l border-primary/15 px-2"
                  aria-label="More approval options"
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="end"
                sideOffset={6}
                className="min-w-56 rounded-xl p-1.5"
              >
                <DropdownMenuItem
                  className="min-h-10 rounded-lg px-3 text-sm"
                  onSelect={() => void submitApproval(false)}
                >
                  Allow once
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-12 flex-col items-start gap-0.5 rounded-lg px-3 text-sm"
                  aria-label={`${reusableApprovalLabel}: ${reusableApprovalDescription}`}
                  onSelect={() => void submitApproval(true)}
                >
                  <span>{reusableApprovalLabel}</span>
                  <span className="max-w-60 truncate text-xs text-muted-foreground">
                    {reusableApprovalDescription}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </form>
  );
}
