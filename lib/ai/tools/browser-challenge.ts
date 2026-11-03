import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import {
  CAPTCHA_PREVIEW_FLAG,
  isCaptchaPreviewEligible,
} from "../captcha/policy";
import {
  browserChallengeObservation,
  DETECT_CHALLENGES_SCRIPT,
  buildDeliverCaptchaScript,
  isCaptchaDemo,
  isSupportedCaptchaDemo,
} from "../captcha/detection";
import { createTwoCaptchaSolver, type CaptchaSolver } from "../captcha/solver";
import { CAPTCHA_VISION_GUIDANCE } from "../captcha/vision-guidance";

export function createBrowserChallenge(
  context: ToolContext,
  environment: string | undefined,
  runSignal?: AbortSignal,
  // Injection supports deterministic tests without any paid network requests.
  solverFactory: (key: string) => CaptchaSolver = createTwoCaptchaSolver,
) {
  let solveStarted = false;
  let active = false;
  return tool({
    description:
      "Inspect the current owned Cloud browser for CAPTCHA widgets or a verification interstitial. When a page shows verification, call inspect before retrying browser actions. For user-authorized vision-only reCAPTCHA v2 or hCaptcha demo testing, inspect returns visionGuidance: follow its fresh-image and selection-feedback workflow using screenshot, file view and ordinary browser input; do not call solve. In this internal Preview pilot, solve is the separate paid adapter, supporting only visible reCAPTCHA v2 and standalone Turnstile on allowlisted public demos. Call alone; one solver attempt per run, with a two-minute deadline. A delivered token is NOT website acceptance: submit the demo normally and verify the website result. Unsupported, failed or expired challenges need browser_handoff; never repeatedly retry or claim verification succeeded from a token alone.",
    inputSchema: z.object({ action: z.enum(["inspect", "solve"]) }),
    execute: async ({ action }, options) => {
      const signals = [runSignal, options.abortSignal].filter(
        (s): s is AbortSignal => !!s,
      );
      const signal = signals.length
        ? AbortSignal.any(signals)
        : new AbortController().signal;
      signal.throwIfAborted();
      if (
        !isCaptchaPreviewEligible(environment, context.userID) ||
        !context.triggerRunId ||
        !context.browserSessions ||
        context.requestToolApproval
      )
        return { status: "unavailable" };
      if (active)
        return {
          status: "busy",
          message: "Do not run browser challenge operations concurrently.",
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
          environment: "PREVIEW",
          ...fields,
        });
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let enabled: boolean | null;
        try {
          enabled = await Promise.race([
            getPostHogBooleanFlagDecisionForUser(
              CAPTCHA_PREVIEW_FLAG,
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
        const browser =
          await context.browserSessions.getChallengeBrowser(signal);
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
        if (action === "inspect")
          return {
            status: "challenge_detected",
            widgets: pending.map(({ kind, invisible }) => ({
              kind,
              invisible,
            })),
            demoEligible: isCaptchaDemo(observation.url),
            interstitial: observation.interstitial,
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
          !isCaptchaDemo(observation.url) ||
          observation.interstitial ||
          pending.length !== 1 ||
          !widget ||
          !isSupportedCaptchaDemo(observation.url, widget) ||
          widget.kind === "hcaptcha" ||
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
        taskStarted = true;
        record("browser_captcha_solver_attempt", { captcha_kind: widget.kind });
        const solution = await solverFactory(key).solve(
          observation.url,
          widget,
          signal,
          (taskId) =>
            record("browser_captcha_solver_charge_pending", {
              provider: "2captcha",
              task_id: taskId,
            }),
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
                "Submit the demo through its normal form and verify the server result. Token delivery does not prove CAPTCHA acceptance. If rejected, use browser_handoff; do not retry the solver.",
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
    },
  });
}
