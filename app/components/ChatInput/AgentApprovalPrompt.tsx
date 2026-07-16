"use client";

import { useCallback } from "react";
import { AlertTriangle, ChevronDown, Hand, LoaderCircle } from "lucide-react";
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
  hasConnectionError?: boolean;
  onRetryConnection?: () => void;
  onStop: () => void;
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

export function AgentApprovalPrompt({
  request,
  hasConnectionError = false,
  onRetryConnection,
  onStop,
}: AgentApprovalPromptProps) {
  const { session, sendToolApproval, toolApprovalSendStates } =
    useAgentApproval();
  const sendState = toolApprovalSendStates[request.approvalId] ?? "idle";
  const isSending = sendState === "sending";
  const isApproved = sendState === "approved";
  const isDenied = sendState === "denied";
  const isSettled = isApproved || isDenied;
  const hasSessionCredentials = Boolean(
    session?.sessionId.trim() && session.publicAccessToken.trim(),
  );
  const canSubmit = hasSessionCredentials && !isSending && !isSettled;
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

  const allowLabel = isApproved
    ? "Approved"
    : isDenied
      ? "Denied"
      : isSending
        ? "Sending..."
        : "Allow once";

  return (
    <form
      aria-busy={isSending}
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

      {!hasSessionCredentials ? (
        <div
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="agent-approval-connection-state"
        >
          <div
            className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"
            role={hasConnectionError ? "alert" : "status"}
          >
            {hasConnectionError && onRetryConnection ? (
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <LoaderCircle
                className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            <span>
              {hasConnectionError
                ? "Could not reconnect to the Agent approval session."
                : "Reconnecting to the Agent approval session..."}
            </span>
          </div>

          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2">
            {hasConnectionError ? (
              <Button
                type="button"
                variant="outline"
                className="w-full rounded-full bg-transparent shadow-none sm:w-auto"
                onClick={onRetryConnection}
              >
                Retry connection
              </Button>
            ) : null}
            <Button
              type="button"
              variant={hasConnectionError ? "destructive" : "outline"}
              className="w-full rounded-full shadow-none sm:w-auto"
              onClick={onStop}
            >
              Stop agent
            </Button>
          </div>
        </div>
      ) : (
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
                    className="min-h-10 rounded-lg px-3 text-sm"
                    aria-label={`${reusableApprovalLabel}: ${reusableApprovalDescription}`}
                    onSelect={() => void submitApproval(true)}
                  >
                    {reusableApprovalLabel}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      )}

      <span className="sr-only" role="status" aria-live="polite">
        {isSending
          ? "Sending approval response."
          : isApproved
            ? "Agent action approved."
            : isDenied
              ? "Agent action denied."
              : ""}
      </span>
    </form>
  );
}
