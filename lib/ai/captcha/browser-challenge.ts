import { z } from "zod";
import type { ToolContext } from "@/types";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import {
  captchaFlag,
  captchaAutomaticSolvingEnabled,
  isCaptchaEligible,
} from "./policy";
import {
  browserChallengeObservation,
  DETECT_CHALLENGES_SCRIPT,
  buildDeliverCaptchaScript,
  isCaptchaDemo,
  isSupportedCaptchaTarget,
} from "./detection";
import { createTwoCaptchaSolver, type CaptchaSolver } from "./solver";
import { CAPTCHA_VISION_GUIDANCE } from "./vision-guidance";
import type { CaptchaJournal } from "./journal";

export function createBrowserChallengeHandler(
  context: ToolContext,
  environment: string | undefined,
  runSignal?: AbortSignal,
  // Injection supports deterministic tests without any paid network requests.
  solverFactory: (key: string) => CaptchaSolver = createTwoCaptchaSolver,
  journal?: CaptchaJournal,
) {
  let solveStarted = false;
  let active = false;
  // Internal browser workflow, never a model-facing tool or model input.
  return async (abortSignal?: AbortSignal) => {
    const signals = [runSignal, abortSignal].filter(
      (s): s is AbortSignal => !!s,
    );
    const signal = signals.length
      ? AbortSignal.any(signals)
      : new AbortController().signal;
    signal.throwIfAborted();
    if (
      !isCaptchaEligible(environment, context.userID) ||
      !context.triggerRunId ||
      !context.browserSessions ||
      context.requestToolApproval
    )
      return { status: "unavailable" };
    if (active)
      return {
        status: "busy",
        message:
          "Another browser challenge check is in progress. Do not retry paid solving.",
      };
    active = true;
    let deliveryStarted = false;
    let taskStarted = false;
    let costRecorded = false;
    const record = (
      event: string,
      fields: Record<string, string | number | boolean> = {},
    ) =>
      phLogger.event(event, {
        userId: context.userID,
        environment: environment!,
        ...fields,
      });
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let enabled: boolean | null;
      try {
        enabled = await Promise.race([
          getPostHogBooleanFlagDecisionForUser(
            captchaFlag(environment),
            context.userID,
            undefined,
            { sendFeatureFlagEvents: false },
          ),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      signal.throwIfAborted();
      if (enabled !== true) return { status: "unavailable" };
      const browser = await context.browserSessions.getChallengeBrowser(signal);
      const observation = browserChallengeObservation.parse(
        await browser.evaluate(DETECT_CHALLENGES_SCRIPT),
      );
      const pending = observation.widgets.filter((w) => !w.tokenPresent);
      if (!pending.length && !observation.interstitial)
        return { status: "no_pending_challenge" };
      record("browser_captcha_challenge_detected", {
        widget_count: pending.length,
        interstitial: observation.interstitial,
      });
      const autoSolve = captchaAutomaticSolvingEnabled(environment);
      if (!autoSolve)
        return {
          status: "challenge_detected",
          widgets: pending.map(({ kind, invisible }) => ({
            kind,
            invisible,
          })),
          demoEligible: isCaptchaDemo(observation.url),
          interstitial: observation.interstitial,
          message:
            "Automatic solving is unavailable for this challenge. Use browser_handoff if human verification is required; do not call external solvers from the terminal.",
          ...(isCaptchaDemo(observation.url) &&
            !observation.interstitial &&
            pending.length === 1 &&
            !pending[0].invisible &&
            (pending[0].kind === "recaptcha_v2" ||
              pending[0].kind === "hcaptcha") && {
              visionGuidance: CAPTCHA_VISION_GUIDANCE,
            }),
        };
      const widget = pending[0];
      if (
        observation.interstitial ||
        pending.length !== 1 ||
        !widget ||
        !isSupportedCaptchaTarget(observation.url, widget) ||
        widget.invisible
      )
        return {
          status: "handoff_required",
          reason: "unsupported_challenge",
        };
      const key = process.env.TWOCAPTCHA_API_KEY;
      if (!key)
        return {
          status: "handoff_required",
          reason: "solver_not_configured",
        };
      if (solveStarted)
        return { status: "handoff_required", reason: "attempt_limit" };
      solveStarted = true; // Includes failures and concurrent calls; no paid retry.
      if (!journal || !(await journal.reserve(widget.kind)))
        return {
          status: "handoff_required",
          reason: "attempt_budget_unavailable",
        };
      signal.throwIfAborted();
      taskStarted = true;
      record("browser_captcha_solver_attempt", { captcha_kind: widget.kind });
      const solution = await solverFactory(key).solve(
        observation.url,
        widget,
        signal,
        async (taskId) => {
          await journal.registerTask(taskId);
          record("browser_captcha_solver_charge_pending", {
            provider: "2captcha",
            task_id: taskId,
          });
        },
        (taskId, costDollars) => journal.recordCost(taskId, costDollars),
      );
      context.onToolCost?.(solution.costDollars);
      costRecorded = true;
      signal.throwIfAborted();
      deliveryStarted = true;
      const delivered = z
        .object({ status: z.enum(["page_changed", "token_delivered"]) })
        .parse(
          await browser.evaluate(
            buildDeliverCaptchaScript(observation, widget, solution.token),
          ),
        );
      record("browser_captcha_solver_result", {
        outcome: delivered.status,
        captcha_kind: widget.kind,
        cost_dollars: solution.costDollars,
      });
      return delivered.status === "token_delivered"
        ? {
            status: "token_delivered",
            websiteAccepted: false,
            message:
              "The runtime delivered the token in this browser. This status is tool-result metadata, not terminal stdout; do not search logs or call the solver again. Take one fresh standalone snapshot, submit the ordinary form and verify the server result. Token delivery does not prove website acceptance. If rejected, use browser_handoff.",
          }
        : { status: "handoff_required", reason: "page_changed" };
    } catch {
      if (taskStarted)
        record("browser_captcha_solver_result", {
          outcome: deliveryStarted
            ? "delivery_outcome_unknown"
            : "provider_outcome_unknown",
          charge_status: costRecorded ? "recorded" : "unreconciled",
        });
      signal.throwIfAborted();
      // Never forward provider responses, solver keys, tokens or script text.
      return {
        status: "handoff_required",
        reason: deliveryStarted
          ? "delivery_outcome_unknown"
          : "challenge_operation_failed",
        ...(deliveryStarted && {
          message:
            "Delivery may have occurred. Inspect the same browser page before any further action; do not repeat the solve.",
        }),
      };
    } finally {
      active = false;
    }
  };
}
