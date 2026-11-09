import type { SidebarTerminal } from "@/types/chat";
import { parseCaptchaRuntimeCommand } from "@/lib/ai/captcha/runtime-command";
import type {
  ShellToolOutput,
  TerminalExecutionPhase,
} from "./shell-tool-utils";

export type CaptchaActivity = NonNullable<SidebarTerminal["captcha"]>;

export function getCaptchaStartedAt(
  parts: readonly unknown[],
  toolCallId: string,
  command: string | undefined,
) {
  if (parseCaptchaRuntimeCommand(command)?.action !== "solve") return;
  for (const part of parts) {
    const p = part as {
      type?: string;
      data?: { toolCallId?: string; captchaStartedAt?: unknown };
    };
    if (p?.type !== "data-terminal" || p.data?.toolCallId !== toolCallId)
      continue;
    const time = p.data.captchaStartedAt;
    if (typeof time === "number" && Number.isFinite(time) && time > 0)
      return time;
  }
}

export function getCaptchaActivity({
  command,
  output,
  executionPhase,
  hasResult,
  isExecuting,
  isRunActive = isExecuting,
  startedAt,
}: {
  command: string;
  output?: ShellToolOutput;
  executionPhase?: TerminalExecutionPhase;
  hasResult: boolean;
  isExecuting: boolean;
  isRunActive?: boolean;
  startedAt?: number;
}): CaptchaActivity | undefined {
  if (parseCaptchaRuntimeCommand(command)?.action !== "solve") return;
  const challenge = output?.result?.browserChallenge;
  let state: CaptchaActivity["state"];
  if (
    executionPhase === "stopped" ||
    (!hasResult && isExecuting && !isRunActive)
  )
    state = "stopped";
  else if (executionPhase === "failed" || output?.result?.exitCode === 1)
    state = "failed";
  else if (!hasResult) state = "solving";
  else if (challenge?.status === "token_delivered")
    state = "response_delivered";
  else if (challenge?.status === "preparation_required")
    state = "preparation_required";
  else if (challenge?.status === "capture_incomplete")
    state = "capture_incomplete";
  else if (challenge?.status === "handoff_required")
    state = "needs_verification";
  else if (challenge?.status === "no_pending_challenge") state = "not_needed";
  else state = "unavailable";
  const timing = output?.result?.callTiming;
  const parsedStart = timing?.startedAt ? Date.parse(timing.startedAt) : NaN;
  const elapsedMs = timing?.elapsedMs;
  return {
    state,
    startedAt:
      startedAt ?? (Number.isFinite(parsedStart) ? parsedStart : undefined),
    elapsedMs:
      typeof elapsedMs === "number" &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= 0
        ? elapsedMs
        : undefined,
  };
}

export function getCaptchaActivityLabel(state: CaptchaActivity["state"]) {
  return {
    solving: "Solving CAPTCHA",
    response_delivered: "Response delivered",
    needs_verification: "Needs verification",
    failed: "CAPTCHA solve failed",
    stopped: "Stopped CAPTCHA solve",
    unavailable: "Solver unavailable",
    preparation_required: "Preparation needed",
    capture_incomplete: "Challenge not ready",
    not_needed: "No pending CAPTCHA",
  }[state];
}

export function formatCaptchaElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
