import { z } from "zod";
import type { ToolContext, AnySandbox } from "@/types";
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
import type { CaptchaSolver } from "./solver";
import { CAPTCHA_RUNTIME_GUIDANCE } from "./guidance";
import { CAPTCHA_VISION_GUIDANCE } from "./vision-guidance";
import type { CaptchaJournal } from "./journal";
import {
  cloudflarePageUrl,
  cloudflarePreviewUrls,
  cloudflareOutcomeScript,
  cloudflareReleaseScript,
  CLOUDFLARE_PAGE_URL_SCRIPT,
} from "./cloudflare";

// Module loading cannot be canceled, but Stop must release its waiter. A late
// initialization only constructs the adapter; it must never start a paid task.
function waitForProvider(
  work: CaptchaSolver | Promise<CaptchaSolver>,
  signal: AbortSignal,
): Promise<CaptchaSolver> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createBrowserChallengeHandler(
  context: ToolContext,
  environment: string | undefined,
  runSignal?: AbortSignal,
  // Injection supports deterministic tests without any paid network requests.
  solverFactory: (
    key: string,
  ) => CaptchaSolver | Promise<CaptchaSolver> = async (key) =>
    (await import("./solver")).createTwoCaptchaSolver(key),
  journal?: CaptchaJournal,
) {
  let solveStarted = false;
  let active = false;
  let guidanceSent = false;
  let providerAttemptStarted = false;
  let providerTaskCreated = false;
  let knownCostDollars: number | undefined;
  let costRecorded = false;
  let deliveryOutcome: "not_attempted" | "unknown" | "delivered" =
    "not_attempted";
  let managedGateOutcome: "cleared" | "pending" | "unknown" | undefined;
  // Internal browser workflow, never a model-facing tool or model input.
  const check = async (
    abortSignal?: AbortSignal,
    target?: { sandbox: AnySandbox; sessionName: string },
  ) => {
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
    let challengeDetected = false;
    const respond = <T extends { status: string }>(result: T) => {
      const response = {
        ...result,
        ...(providerTaskCreated && {
          provider: "2captcha",
          providerTaskCreated: true,
        }),
        ...(knownCostDollars !== undefined && {
          providerCostUSD: knownCostDollars,
        }),
      };
      if (!challengeDetected || guidanceSent) return response;
      guidanceSent = true;
      return { ...response, guidance: CAPTCHA_RUNTIME_GUIDANCE };
    };
    let deliveryStarted = false;
    let taskStarted = false;
    const recordToolCost = (costDollars: number) => {
      if (costRecorded) return;
      costRecorded = true;
      context.onToolCost?.(costDollars);
    };
    let releaseManaged: (() => Promise<unknown>) | undefined;
    let managedDelivered = false;
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
      if (enabled !== true) {
        const approvedUrls = cloudflarePreviewUrls(environment);
        // Setup may have captured a widget before the rollout became
        // unavailable. Release only the current owned Cloud document; no
        // challenge parameters, provider calls or ordinary browser inspection.
        if (approvedUrls.length) {
          try {
            const browser = await context.browserSessions.getChallengeBrowser(
              signal,
              target,
            );
            if (browser.deliverCloudflare)
              await browser.evaluate(cloudflareReleaseScript(approvedUrls));
          } catch {
            // A lost/paused owner cannot be used for cleanup either.
          }
        }
        signal.throwIfAborted();
        return respond({ status: "unavailable" });
      }
      const browser = await context.browserSessions.getChallengeBrowser(
        signal,
        target,
      );
      const observation = browserChallengeObservation.parse(
        await browser.evaluate(DETECT_CHALLENGES_SCRIPT),
      );
      const pending = observation.widgets.filter((w) => !w.tokenPresent);
      const managed = pending.find((w) => w.managed);
      if (managed)
        releaseManaged = () =>
          browser.evaluate(`(() => {
        if (${CLOUDFLARE_PAGE_URL_SCRIPT} !== ${JSON.stringify(cloudflarePageUrl(observation.url))} || String(performance.timeOrigin) !== ${JSON.stringify(observation.documentId)}) return false;
        const current = window[Symbol.for('hackerai.cloudflareChallenge')];
        if (current?.observationId !== ${JSON.stringify(managed.observationId)} || current.delivered || typeof current.release !== 'function') return false;
        current.release(); return true;
      })()`);
      if (!pending.length && !observation.interstitial)
        return respond({ status: "no_pending_challenge" });
      challengeDetected = true;
      record("browser_captcha_challenge_detected", {
        widget_count: pending.length,
        interstitial: observation.interstitial,
      });
      const autoSolve = captchaAutomaticSolvingEnabled(environment);
      if (!autoSolve)
        return respond({
          status: "challenge_detected",
          widgets: pending.map(({ kind, invisible }) => ({
            kind,
            invisible,
          })),
          demoEligible: isCaptchaDemo(observation.url),
          interstitial: observation.interstitial,
          message:
            "Automatic solving is unavailable for this challenge. If human verification is required, use browser_handoff only for the current Cloud browser. For a connected Local, Desktop or remote browser, stop and explain that manual verification is required and in-app takeover is unavailable. Do not call external solvers from the terminal.",
          ...(isCaptchaDemo(observation.url) &&
            !observation.interstitial &&
            pending.length === 1 &&
            !pending[0].invisible &&
            (pending[0].kind === "recaptcha_v2" ||
              pending[0].kind === "hcaptcha") && {
              visionGuidance: CAPTCHA_VISION_GUIDANCE,
            }),
        });
      const widget = pending[0];
      if (
        (observation.interstitial && !widget?.managed) ||
        pending.length !== 1 ||
        !widget ||
        !isSupportedCaptchaTarget(observation.url, widget) ||
        widget.invisible
      )
        return respond({
          status: "handoff_required",
          reason: "unsupported_challenge",
        });
      if (widget.managed && !browser.deliverCloudflare)
        return respond({
          status: "handoff_required",
          reason: "unsupported_transport",
        });
      const key = process.env.TWOCAPTCHA_API_KEY;
      if (!key)
        return respond({
          status: "handoff_required",
          reason: "solver_not_configured",
        });
      if (solveStarted)
        return respond({ status: "handoff_required", reason: "attempt_limit" });
      solveStarted = true; // Includes failures and concurrent calls; no paid retry.
      if (!journal || !(await journal.reserve(widget.kind)))
        return respond({
          status: "handoff_required",
          reason: "attempt_budget_unavailable",
        });
      signal.throwIfAborted();
      const solver = await waitForProvider(solverFactory(key), signal);
      signal.throwIfAborted();
      taskStarted = true;
      providerAttemptStarted = true;
      record("browser_captcha_solver_attempt", { captcha_kind: widget.kind });
      const solution = await solver.solve(
        widget.managed ? cloudflarePageUrl(observation.url)! : observation.url,
        widget,
        signal,
        async (taskId) => {
          providerTaskCreated = true;
          await journal.registerTask(taskId);
          record("browser_captcha_solver_charge_pending", {
            provider: "2captcha",
            task_id: taskId,
          });
        },
        (taskId, costDollars) => {
          providerTaskCreated = true;
          knownCostDollars = costDollars;
          recordToolCost(costDollars);
          return journal.recordCost(taskId, costDollars);
        },
      );
      providerTaskCreated = true;
      knownCostDollars = solution.costDollars;
      recordToolCost(solution.costDollars);
      signal.throwIfAborted();
      deliveryStarted = true;
      deliveryOutcome = "unknown";
      const deliveryScript = buildDeliverCaptchaScript(
        observation,
        widget,
        solution.token,
      );
      if (widget.managed && !solution.userAgent)
        throw new Error("Missing managed challenge user agent.");
      const delivered = z
        .object({ status: z.enum(["page_changed", "token_delivered"]) })
        .parse(
          widget.managed
            ? await browser.deliverCloudflare!(
                solution.userAgent!,
                {
                  url: cloudflarePageUrl(observation.url)!,
                  documentId: observation.documentId,
                  originalUserAgent: widget.managed.userAgent,
                },
                deliveryScript,
              )
            : await browser.evaluate(deliveryScript),
        );
      record("browser_captcha_solver_result", {
        outcome: delivered.status,
        captcha_kind: widget.kind,
        cost_dollars: solution.costDollars,
      });
      managedDelivered = delivered.status === "token_delivered";
      if (managedDelivered) deliveryOutcome = "delivered";
      if (widget.managed && managedDelivered) {
        managedGateOutcome = "unknown";
        // Navigation can destroy the first evaluation. Retry only this owned,
        // bounded observation, never task creation or callback delivery.
        for (let read = 0; read < 2; read++) {
          signal.throwIfAborted();
          try {
            const outcome = z
              .enum(["cleared", "pending", "page_changed"])
              .parse(
                await browser.evaluate(
                  cloudflareOutcomeScript(cloudflarePageUrl(observation.url)!),
                ),
              );
            signal.throwIfAborted();
            managedGateOutcome =
              outcome === "page_changed" ? "unknown" : outcome;
            break;
          } catch {
            signal.throwIfAborted();
          }
        }
        if (managedGateOutcome === "pending") {
          signal.throwIfAborted();
          let restored = false;
          try {
            // Revalidate ownership for the mutation after the read-only wait;
            // a stopped in-page promise must never mutate a handed-off page.
            restored =
              (await browser.evaluate(
                cloudflareReleaseScript([cloudflarePageUrl(observation.url)!]),
              )) === true;
          } catch {
            signal.throwIfAborted();
          }
          signal.throwIfAborted();
          return respond({
            status: "handoff_required",
            reason: "managed_gate_not_cleared",
            responseDelivered: true,
            websiteAccepted: false,
            manualWidgetRestored: restored,
            message: `2Captcha delivered one response, but the managed gate remained or issued another challenge. Its paid attempt is used. ${restored ? "The current widget was restored for manual verification." : "Manual verification is required."} Do not create another task or resubmit the response.`,
          });
        }
      }
      return respond(
        delivered.status === "token_delivered"
          ? {
              status: "token_delivered",
              websiteAccepted: false,
              ...(widget.managed && {
                managedGateCleared:
                  managedGateOutcome === "unknown"
                    ? null
                    : managedGateOutcome === "cleared",
              }),
              message: `2Captcha completed one paid task (provider cost ${solution.costDollars} USD), and the runtime delivered its response in this browser. This is tool-result metadata, not terminal stdout; do not search logs or call the solver again. Take one fresh standalone snapshot and check whether a callback already submitted the form. Submit only if it has not been submitted, then verify the server result. Delivery does not prove website acceptance. For rejection or an uncertain submission outcome, do not resubmit: use browser_handoff only for the current Cloud browser. On connected Local, Desktop or remote browsers, stop and explain that manual verification is required and in-app takeover is unavailable.`,
            }
          : { status: "handoff_required", reason: "page_changed" },
      );
    } catch (error) {
      const solverTimedOut =
        !signal.aborted &&
        taskStarted &&
        !deliveryStarted &&
        error instanceof Error &&
        error.name === "TimeoutError";
      if (taskStarted)
        record("browser_captcha_solver_result", {
          outcome: deliveryStarted
            ? "delivery_outcome_unknown"
            : solverTimedOut
              ? "solver_timeout"
              : "provider_outcome_unknown",
          charge_status: costRecorded ? "recorded" : "unreconciled",
        });
      signal.throwIfAborted();
      // Never forward provider responses, solver keys, tokens or script text.
      return respond({
        status: "handoff_required",
        reason: deliveryStarted
          ? "delivery_outcome_unknown"
          : solverTimedOut
            ? "solver_timeout"
            : "challenge_operation_failed",
        ...(solverTimedOut && {
          message:
            "The solver deadline expired. The existing paid task may still finish and its cost will be reconciled. Do not create another task or continue solving this challenge; manual verification is required.",
        }),
        ...(deliveryStarted && {
          message:
            "Delivery may have occurred. Inspect the same browser page before any further action; do not repeat the solve.",
        }),
      });
    } finally {
      // A failed/disabled solver must leave the same page usable for human
      // verification. The page-side fence refuses release after delivery.
      if (releaseManaged && !managedDelivered && !signal.aborted)
        await releaseManaged().catch(() => undefined);
      active = false;
    }
  };
  return Object.assign(check, {
    getReceiptPrompt: () =>
      providerAttemptStarted
        ? `\n<captcha_runtime_receipt>\nAuthoritative receipt for this run, refreshed by the runtime. Provider: 2Captcha. Paid task creation: ${providerTaskCreated ? "confirmed, exactly one task" : "outcome unknown; do not retry"}. Provider cost: ${knownCostDollars === undefined ? "unknown, never report zero" : `${knownCostDollars} USD`}. Response delivery: ${deliveryOutcome}.${managedGateOutcome ? ` Managed gate at the post-delivery check: ${managedGateOutcome}.` : ""}\nUse these exact provider/task/cost facts in the final recap; do not substitute model API costs or invent providers, amounts, task IDs or URLs. Repeated receipt text is the same task, not an additional charge. Delivery does not prove form submission or website acceptance; report those only from observed page evidence. No second paid attempt.\n</captcha_runtime_receipt>\n`
        : "",
  });
}
