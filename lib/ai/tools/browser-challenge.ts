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
  isSupportedCaptchaTarget,
} from "../captcha/detection";
import { createTwoCaptchaSolver, type CaptchaSolver } from "../captcha/solver";
import { CAPTCHA_VISION_GUIDANCE } from "../captcha/vision-guidance";
import {
  isBrowserlessFallbackTarget,
  openBrowserlessFallback,
} from "../captcha/browserless-session";
import { createBrowserlessTunnel } from "../captcha/browserless-tunnel";

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
      "Inspect the current owned browser for CAPTCHA widgets or a verification interstitial. Cloud, remote connections and Desktop use the same server-side solver; provider keys never enter the browser or terminal. When internal Preview automatic solving is enabled, inspect solves supported pending challenges on server-approved targets in place once, preserving the current page and login. When a page shows verification, call inspect before retrying browser actions. If the internal Preview Browserless fallback is enabled, inspect switches to a fresh hosted browser only after detecting a pending supported CAPTCHA on an approved public demo. On browserless_fallback_ready, immediately run agent-browser snapshot -i in the same session, then submit the normal demo form and verify the website result; do not reopen the page or switch sessions. The hosted browser has a short lifetime. Normal pages do not allocate Browserless. Call this tool alone; only one provider attempt per run, including failures. Otherwise inspect can return visionGuidance for authorized vision-only demo testing. The solve action is the separate 2Captcha adapter. Unsupported, failed or expired challenges need browser_handoff; never retry a paid attempt or claim website acceptance from a provider solve alone.",
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
      let browserlessStarted = false;
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
        const autoSolve =
          action === "inspect" &&
          process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW === "1" &&
          !!process.env.TWOCAPTCHA_API_KEY &&
          !observation.interstitial &&
          pending.length === 1 &&
          !pending[0].invisible &&
          isSupportedCaptchaTarget(observation.url, pending[0]);
        if (
          action === "inspect" &&
          !autoSolve &&
          browser.supportsHostedFallback !== false &&
          process.env.HACKERAI_BROWSERLESS_FALLBACK_PREVIEW === "1" &&
          process.env.HACKERAI_ENVIRONMENT === "preview"
        ) {
          if (
            !isBrowserlessFallbackTarget(observation.url) ||
            observation.interstitial ||
            pending.length !== 1 ||
            pending[0].invisible
          )
            return {
              status: "handoff_required",
              reason: "unsupported_fallback_target",
            };
          if (solveStarted)
            return { status: "handoff_required", reason: "attempt_limit" };
          const key = process.env.BROWSERLESS_API_KEY;
          if (!key)
            return {
              status: "handoff_required",
              reason: "solver_not_configured",
            };
          solveStarted = true;
          browserlessStarted = true;
          record("browser_captcha_browserless_fallback_started", {
            captcha_kind: pending[0].kind,
          });
          const remote = await openBrowserlessFallback(
            observation.url,
            key,
            signal,
          );
          let adopted = false;
          try {
            await browser.adoptRemote(
              { url: observation.url, documentId: observation.documentId },
              (sandbox, directory) =>
                createBrowserlessTunnel(sandbox, directory, remote, signal),
            );
            signal.throwIfAborted();
            adopted = true;
            record("browser_captcha_browserless_fallback_result", {
              outcome: "browser_adopted",
              captcha_kind: pending[0].kind,
            });
            return {
              status: "browserless_fallback_ready",
              browserChanged: true,
              providerSolved: true,
              websiteAccepted: false,
              remainingSeconds: Math.max(
                0,
                Math.floor((remote.expiresAt - Date.now()) / 1000),
              ),
              message:
                "The same agent-browser commands now control the hosted demo browser. Immediately run agent-browser snapshot -i, then submit the demo normally and verify its server result. Do not open/reload the URL or change sessions: that would discard the solved challenge. This is a fresh public-demo session; no original cookies or form data were copied. If it fails or expires, request human handoff; do not repeat the fallback.",
            };
          } finally {
            if (!adopted) await remote.close();
          }
        }
        if (action === "inspect" && !autoSolve)
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
                "Submit the page through its normal form and verify the server result. Token delivery does not prove CAPTCHA acceptance. If rejected, use browser_handoff; do not retry the solver.",
            }
          : { status: "handoff_required", reason: "page_changed" };
      } catch {
        if (browserlessStarted)
          record("browser_captcha_browserless_fallback_result", {
            outcome: "failed_or_cancelled",
          });
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
