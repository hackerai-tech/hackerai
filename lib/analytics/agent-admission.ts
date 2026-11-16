import { after } from "next/server";
import { v5 as uuidv5 } from "uuid";
import { phLogger } from "@/lib/posthog/server";

export const AGENT_RUN_ADMITTED_EVENT = "agent_run_admitted";
const AGENT_ADMISSION_ANALYTICS_VERSION = 1;

/** Same scheme as hackerai-agent_run, so admission joins its terminal event. */
export const agentRunAdmittedEventUuid = (runId: string) =>
  uuidv5(
    `hackerai:agent-run:v1:${runId}:${AGENT_RUN_ADMITTED_EVENT}`,
    uuidv5.URL,
  );

/**
 * Denominator for Agent run outcomes: one event per Trigger run whose chat
 * ownership was established, so a run whose worker never reports a terminal
 * hackerai-agent_run still counts (as incomplete) instead of disappearing.
 *
 * Operational and privacy-safe: no prompts, messages, URLs or tokens, and no
 * experiment lookup. Best effort; never affects the admission response.
 */
export function captureAgentRunAdmitted({
  runId,
  userId,
  subscription,
  isAutoContinue,
}: {
  runId: string;
  userId: string;
  subscription: string;
  isAutoContinue: boolean;
}): void {
  try {
    phLogger.event(AGENT_RUN_ADMITTED_EVENT, {
      userId,
      eventUuid: agentRunAdmittedEventUuid(runId),
      trigger_run_id: runId,
      subscription_tier: subscription,
      is_auto_continue: isAutoContinue,
      mode: "agent",
      analytics_definition_version: AGENT_ADMISSION_ANALYTICS_VERSION,
      $process_person_profile: false,
      $geoip_disable: true,
    });
    // Deliver after the response; serverless instances may freeze otherwise.
    after(() => phLogger.flush().catch(() => undefined));
  } catch {
    // Telemetry must never change Agent admission.
  }
}
