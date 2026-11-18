import { BROWSER_HANDOFF_ABANDONED_FINISH_REASON } from "@/lib/ai/browser-handoff/constants";
import {
  LOCAL_CONNECTION_LOST_FINISH_REASON,
  LocalConnectionLostError,
} from "./local-connection-stop";

export { BROWSER_HANDOFF_ABANDONED_FINISH_REASON };

/** Stop reason recorded only after the backend committed the abandonment. */
export class BrowserHandoffAbandonedError extends Error {
  constructor() {
    super("The unattended browser handoff expired.");
    this.name = "BrowserHandoffAbandonedError";
  }
}

export type ManualAgentResumeFinishReason =
  | typeof LOCAL_CONNECTION_LOST_FINISH_REASON
  | typeof BROWSER_HANDOFF_ABANDONED_FINISH_REASON;

/** A run that ended this way continues only after an explicit user resume. */
export function requiresManualAgentResume(
  finishReason: string | null | undefined,
): finishReason is ManualAgentResumeFinishReason {
  return (
    finishReason === LOCAL_CONNECTION_LOST_FINISH_REASON ||
    finishReason === BROWSER_HANDOFF_ABANDONED_FINISH_REASON
  );
}

/** The persisted finish reason for the first stop's constructed reason. */
export function manualAgentResumeFinishReason(
  stopReason: unknown,
): ManualAgentResumeFinishReason | undefined {
  if (stopReason instanceof LocalConnectionLostError)
    return LOCAL_CONNECTION_LOST_FINISH_REASON;
  if (stopReason instanceof BrowserHandoffAbandonedError)
    return BROWSER_HANDOFF_ABANDONED_FINISH_REASON;
  return undefined;
}
