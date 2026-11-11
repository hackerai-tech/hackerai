import { z } from "zod";
import type { ToolContext, AnySandbox } from "@/types";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import { CAPTCHA_SOLVER_FLAG, isCaptchaEligible } from "./policy";
import {
  browserChallengeObservation,
  type BrowserChallengeObservation,
  DETECT_CHALLENGES_SCRIPT,
  buildDeliverCaptchaScript,
  isCaptchaDemo,
  isSupportedCaptchaTarget,
} from "./detection";
import type { CaptchaSolver } from "./solver";
import {
  CAPTCHA_RUNTIME_GUIDANCE,
  getCaptchaUnsolvableVisionGuidance,
} from "./guidance";
import {
  buildVisionCaptureScripts,
  visionScreenshotRequest,
  type VisionCapture,
} from "./vision-capture";
import { CaptchaUnsolvableError } from "./provider-error";
import {
  isAgentBrowserSnapshotCommand,
  getStandaloneScreenshotHint,
} from "@/lib/utils/agent-browser-command";
import { CAPTCHA_VISION_GUIDANCE } from "./vision-guidance";
import {
  applyVisionProgress,
  INITIAL_VISION_PROGRESS,
  VISION_REJECTION_LIMIT,
  type VisionProgress,
  type VisionProgressReport,
  type VisionProgressStop,
} from "./vision-progress";
import type { CaptchaJournal } from "./journal";
import {
  cloudflarePageUrl,
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
  let capabilityOffered = false;
  let captureRecoveryOffered = false;
  let providerAttemptStarted = false;
  let providerTaskCreated = false;
  let knownCostDollars: number | undefined;
  let costRecorded = false;
  let deliveryOutcome: "not_attempted" | "unknown" | "delivered" =
    "not_attempted";
  let managedGateOutcome: "cleared" | "pending" | "unknown" | undefined;
  let providerUnsolvable = false;
  type VisionScope = {
    identity: string;
    url: string;
    documentId: string;
    sessionName: string;
    kind: string;
    siteKey: string;
    widgetId?: string;
  };
  // Recovery stops on reported verification feedback, never on elapsed time or
  // accepted stages; general run limits still apply.
  let visionFallback:
    | (VisionScope & {
        target: Target;
        captureSupported: boolean;
        progress: VisionProgress;
        /** No pending challenge at the last owned observation. */
        completed?: boolean;
        /** A command after completion may have submitted the form. */
        actedAfterCompletion?: boolean;
        stopped?:
          | "vision_page_changed"
          | "vision_challenge_returned"
          | "vision_capture_unavailable"
          | VisionProgressStop;
      })
    | undefined;
  const describeVisionProgress = ({
    nextAttempt,
    rejected,
  }: VisionProgress) => ({
    nextAttempt,
    rejectedVerifications: rejected,
    rejectionLimit: VISION_REJECTION_LIMIT,
  });
  const ownedVisionRequest = (scope: NonNullable<typeof visionFallback>) => ({
    target: scope.target,
    url: scope.url,
    documentId: scope.documentId,
    identity: scope.identity,
  });
  const matchesVisionScope = (
    identity: string,
    observation: BrowserChallengeObservation,
    sessionName: string | undefined,
    scope: VisionScope,
  ) => {
    const widget = observation.widgets[0];
    return (
      identity === scope.identity &&
      sessionName === scope.sessionName &&
      observation.url === scope.url &&
      observation.documentId === scope.documentId &&
      !observation.interstitial &&
      observation.widgets.length === 1 &&
      widget.kind === scope.kind &&
      widget.siteKey === scope.siteKey &&
      widget.hcaptchaWidgetId === scope.widgetId &&
      !widget.tokenPresent &&
      !widget.invisible &&
      !widget.managed
    );
  };

  type Target = { sandbox: AnySandbox; sessionName: string };
  type Request = {
    target: Target;
    url: string;
    documentId: string;
    identity: string;
  };
  let pendingRequest: Request | undefined;
  // Internal browser workflow, never a model-facing tool or model input.
  const check = async (
    abortSignal?: AbortSignal,
    target?: Target,
    action: "inspect" | "solve" | "release" | "capture" | "progress" = "solve",
    expected?: Request,
    capturePath?: string,
    report?: VisionProgressReport,
  ) => {
    const signals = [runSignal, abortSignal].filter(
      (s): s is AbortSignal => !!s,
    );
    const signal = signals.length
      ? AbortSignal.any(signals)
      : new AbortController().signal;
    signal.throwIfAborted();
    if (
      !isCaptchaEligible(environment) ||
      !context.triggerRunId ||
      !context.browserSessions ||
      context.requestToolApproval
    )
      return { status: "unavailable" };
    if ((action === "capture" || action === "progress") && !visionFallback)
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
        ...(action === "inspect" &&
          !providerAttemptStarted && {
            providerTaskCreated: false,
            providerCostUSD: 0,
          }),
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
    let attemptedScope: VisionScope | undefined;
    const visionReply = (available: boolean, reason = "provider_unsolvable") =>
      respond({
        // Verification is still pending; this does not itself invoke handoff.
        status: "handoff_required",
        reason,
        visionFallbackAvailable: available,
        visionCaptureSupported:
          available && visionFallback?.captureSupported === true,
        ...(visionFallback && {
          visionProgress: describeVisionProgress(visionFallback.progress),
        }),
        ...(available && {
          visionGuidance: getCaptchaUnsolvableVisionGuidance(
            visionFallback!.captureSupported,
          ),
        }),
        message: available
          ? "2Captcha returned confirmed unsolvable with no delivered response and zero provider fee. Try the vision workflow in this same browser now and report each Next/Verify result with the progress command in visionGuidance. Recovery stops after two rejected verifications or uncertain feedback. No further paid attempt is permitted."
          : `2Captcha returned confirmed unsolvable with no delivered response and zero provider fee. ${
              reason === "vision_verification_rejected"
                ? "Two rejected verifications were reported, so native vision recovery has ended."
                : reason === "vision_feedback_uncertain"
                  ? "Native vision recovery has ended because verification feedback was uncertain, skipped or conflicting."
                  : "Vision recovery is unavailable or has ended for this challenge."
            } Do not click, retry, reload or reset the challenge. Request human takeover with browser_handoff for this Cloud browser; for Local, Desktop or remote browsers explain that manual verification is required. Do not request another paid solve.`,
      });
    const recordToolCost = (costDollars: number) => {
      if (costRecorded) return;
      costRecorded = true;
      context.onToolCost?.(costDollars);
    };
    let releaseManaged: (() => Promise<unknown>) | undefined;
    let managedDelivered = false;
    let awaitingDecision = false;
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
            CAPTCHA_SOLVER_FLAG,
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
        // Setup may have captured a widget before the rollout became
        // unavailable. Release only the current owned Cloud document; no
        // challenge parameters, provider calls or ordinary browser inspection.
        if (environment === "PREVIEW") {
          try {
            const browser = await context.browserSessions.getChallengeBrowser(
              signal,
              target,
            );
            if (browser.deliverCloudflare)
              await browser.evaluate(cloudflareReleaseScript());
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
      if (
        expected &&
        (browser.identity !== expected.identity ||
          observation.url !== expected.url ||
          observation.documentId !== expected.documentId)
      )
        return respond({
          status: "page_changed",
          message:
            "The detected page changed. Take a fresh snapshot; no paid solve was attempted.",
        });
      const pending = observation.widgets.filter((w) => !w.tokenPresent);
      const managed = pending.find((w) => w.managed);
      if (managed)
        releaseManaged = () =>
          browser.evaluate(`(() => {
        if (${CLOUDFLARE_PAGE_URL_SCRIPT} !== ${JSON.stringify(cloudflarePageUrl(observation.url))} || String(performance.timeOrigin) !== ${JSON.stringify(observation.documentId)}) return false;
        const current = window[Symbol.for('hackerai.cloudflareChallenge')];
        if (current?.observationId !== ${JSON.stringify(managed.observationId)} || current.delivered || typeof current.release !== 'function') return false;
        return current.release() === true;
      })()`);
      if (!pending.length && !observation.interstitial) {
        if (
          visionFallback &&
          browser.identity === visionFallback.identity &&
          target?.sessionName === visionFallback.sessionName &&
          observation.url === visionFallback.url &&
          observation.documentId === visionFallback.documentId
        ) {
          // Human verification may resolve a challenge after recovery stopped;
          // completion permits the authorized form action in either case.
          visionFallback.completed = true;
        } else if (visionFallback && !visionFallback.completed) {
          // Navigating away is not evidence that the original widget completed.
          visionFallback.stopped ??= "vision_page_changed";
        }
        return respond({ status: "no_pending_challenge" });
      }
      if (action === "release") {
        // Releasing must never clear an ended recovery and revive automation.
        if (visionFallback?.stopped)
          return visionReply(false, visionFallback.stopped);
        visionFallback = undefined;
        const restored = managed
          ? (await releaseManaged?.()) === true
          : undefined;
        releaseManaged = undefined;
        return respond({
          status: restored === false ? "release_skipped" : "released",
          ...(managed && { manualWidgetRestored: restored }),
          message:
            restored === false
              ? "Automatic solving declined. No paid task was created. The captured widget could not be restored; do not claim manual verification is ready. If no form action was submitted and restarting verification is safe, reload this same page once and inspect it before requesting human takeover. Otherwise explain the blocked state; never reload an uncertain form submission."
              : "Automatic solving declined. No new paid task was created; use manual verification if needed.",
        });
      }
      if (visionFallback) {
        // The same widget may expire or issue a fresh puzzle after completion.
        // Continue unless a later command may have submitted the form: a
        // returning challenge then makes that submission's outcome uncertain.
        if (visionFallback.completed) {
          visionFallback.completed = false;
          if (visionFallback.actedAfterCompletion)
            visionFallback.stopped ??= "vision_challenge_returned";
        }
        const samePage = matchesVisionScope(
          browser.identity,
          observation,
          target?.sessionName,
          visionFallback,
        );
        if (!samePage) visionFallback.stopped ??= "vision_page_changed";
        if (action === "capture" && samePage && !visionFallback.stopped) {
          try {
            if (!browser.captureVision || !capturePath) throw new Error();
            const capture = await browser.captureVision({
              path: capturePath,
              ...buildVisionCaptureScripts(visionFallback),
            });
            signal.throwIfAborted();
            return respond({
              status: "vision_capture_ready",
              capture,
              visionFallbackAvailable: true,
              visionProgress: describeVisionProgress(visionFallback.progress),
            });
          } catch {
            signal.throwIfAborted();
            visionFallback.stopped ??= "vision_capture_unavailable";
            return visionReply(false, "vision_capture_unavailable");
          }
        }
        // Mutate only after ownership, scope and cancellation are confirmed.
        if (action === "progress" && samePage && !visionFallback.stopped) {
          signal.throwIfAborted();
          const previous = visionFallback.progress;
          const progress = applyVisionProgress(previous, report);
          visionFallback.progress = progress;
          if (progress.stopped) visionFallback.stopped = progress.stopped;
          else
            return respond({
              status:
                progress === previous
                  ? "vision_progress_unchanged"
                  : "vision_progress_recorded",
              visionFallbackAvailable: true,
              visionProgress: describeVisionProgress(progress),
              message:
                progress === previous
                  ? `This report was already recorded or is older than the last one; nothing changed. Report the next Next/Verify result as --attempt ${progress.nextAttempt}.`
                  : `Recorded attempt ${progress.last?.attempt} as ${progress.last?.outcome}. Report the next Next/Verify result as --attempt ${progress.nextAttempt}.`,
            });
        }
        if (samePage && target && action === "inspect")
          pendingRequest = {
            target,
            url: observation.url,
            documentId: observation.documentId,
            identity: browser.identity,
          };
        return visionReply(
          action === "inspect" && samePage && !visionFallback.stopped,
          !samePage
            ? "vision_page_changed"
            : (visionFallback.stopped ?? "provider_unsolvable"),
        );
      }
      // Recovery may have been closed while this check awaited the browser.
      if (action === "capture" || action === "progress")
        return respond({ status: "unavailable" });
      challengeDetected = true;
      record("browser_captcha_challenge_detected", {
        widget_count: pending.length,
        interstitial: observation.interstitial,
        ...(environment === "PREVIEW" &&
          observation.interstitial &&
          observation.cloudflareCaptureState && {
            capture_state: observation.cloudflareCaptureState,
            script_load_observed: observation.cloudflareScriptLoaded === true,
          }),
      });
      if (!process.env.TWOCAPTCHA_API_KEY && action === "inspect")
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
      if (solveStarted)
        return respond({ status: "handoff_required", reason: "attempt_limit" });
      if (
        environment === "PREVIEW" &&
        observation.interstitial &&
        pending.length === 0 &&
        observation.cloudflareCaptureState !== "captured"
      ) {
        const state = observation.cloudflareCaptureState;
        const recoverable =
          state === "api_not_ready" || state === "render_not_captured";
        const offerRecovery = recoverable && !captureRecoveryOffered;
        if (offerRecovery) captureRecoveryOffered = true;
        return respond({
          status: offerRecovery ? "capture_incomplete" : "handoff_required",
          reason: "managed_parameters_not_captured",
          captureState: state ?? "unknown",
          providerTaskCreated: false,
          providerCostUSD: 0,
          recoveryAvailable: offerRecovery,
          message: offerRecovery
            ? "Cloudflare verification was detected, but the required solver parameters were not captured. This is not a provider rejection. Only if no form or account action has been submitted and this is still the read-only verification interstitial, reload this same page once in this owned session and take a fresh standalone snapshot. Otherwise stop for manual verification. Do not request a paid solve without solve_available. No further capture reloads are offered in this run."
            : "Cloudflare verification was detected, but no solver-ready widget was captured. Do not classify this as a 2Captcha failure or invent challenge parameters. Automatic recovery is unavailable or has already been offered; stop for manual verification. No paid task was created.",
        });
      }
      if (
        (observation.interstitial && !widget?.managed) ||
        (widget?.managed && environment !== "PREVIEW") ||
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
      // Canceling hCaptcha's visual challenge can clear response fields. Do it
      // before spending/applying a response, including when the overlay opened
      // after the earlier offer. A fresh snapshot must revalidate the widget.
      if (widget.kind === "hcaptcha" && observation.hcaptchaChallengeOpen)
        return respond({
          status: "preparation_required",
          providerTaskCreated: false,
          providerCostUSD: 0,
          message: `Close the open hCaptcha visual challenge BEFORE requesting a solve: press Escape once in this same browser session${target ? ` with agent-browser --session ${target.sessionName} press Escape` : ""}, then take a fresh standalone snapshot. No paid task has been created. Do not press Escape, reset, or reopen the widget after a response is delivered.`,
        });
      const key = process.env.TWOCAPTCHA_API_KEY;
      if (!key)
        return respond({
          status: "handoff_required",
          reason: "solver_not_configured",
        });
      if (action === "inspect") {
        if (!target) return respond({ status: "unavailable" });
        pendingRequest = {
          target,
          url: observation.url,
          documentId: observation.documentId,
          identity: browser.identity,
        };
        awaitingDecision = true;
        if (!capabilityOffered) {
          capabilityOffered = true;
          record("browser_captcha_solve_offered", {
            captcha_kind: widget.kind,
          });
        }
        return respond({
          status: "solve_available",
          message: `A supported CAPTCHA is ready for 2Captcha. If verification blocks the authorized task, your NEXT tool call should be run_terminal_cmd with exactly: hackerai-captcha solve --session ${target.sessionName}. Do not first click the checkbox, solve the puzzle by vision, or probe the prepared widget. Respect the user's budget and any explicit vision-only or no-paid-solvers request. If solving is unnecessary or unauthorized, restore the widget with hackerai-captcha release --session ${target.sessionName}. These are runtime commands, not installed shell programs. Use foreground, non-interactive mode with no pipes or appended commands. No paid task has been created.`,
        });
      }
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
      if (
        target &&
        !widget.managed &&
        (widget.kind === "hcaptcha" || widget.kind === "recaptcha_v2")
      )
        attemptedScope = {
          identity: browser.identity,
          url: observation.url,
          documentId: observation.documentId,
          sessionName: target.sessionName,
          kind: widget.kind,
          siteKey: widget.siteKey,
          widgetId: widget.hcaptchaWidgetId,
        };
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
        .object({
          status: z.enum(["page_changed", "token_delivered"]),
          responseRetained: z.boolean().optional(),
        })
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
      if (delivered.responseRetained === false)
        return respond({
          status: "handoff_required",
          reason: "response_not_retained",
          responseDelivered: true,
          websiteAccepted: false,
          message:
            "The response was delivered, but the page no longer retains it. A callback may have submitted or reset the form. Check the current website result without another paid solve, widget reset, or repeated submission. If acceptance is uncertain, stop for manual verification.",
        });
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
              ...(delivered.responseRetained !== undefined && {
                responseRetained: delivered.responseRetained,
              }),
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
      const unsolvable =
        !signal.aborted &&
        taskStarted &&
        providerTaskCreated &&
        !deliveryStarted &&
        error instanceof CaptchaUnsolvableError;
      if (unsolvable) {
        providerUnsolvable = true;
        knownCostDollars = 0;
        recordToolCost(0);
        pendingRequest = undefined;
        record("browser_captcha_solver_result", {
          outcome: "provider_unsolvable",
          cost_dollars: 0,
          charge_status: "confirmed_zero",
        });
        // A provider response cannot authorize vision on a navigated page or
        // another owned session. Revalidate after the potentially long wait.
        if (attemptedScope && target) {
          try {
            const currentBrowser =
              await context.browserSessions.getChallengeBrowser(signal, target);
            const current = browserChallengeObservation.parse(
              await currentBrowser.evaluate(DETECT_CHALLENGES_SCRIPT),
            );
            if (
              matchesVisionScope(
                currentBrowser.identity,
                current,
                target.sessionName,
                attemptedScope,
              )
            )
              visionFallback = {
                ...attemptedScope,
                target,
                captureSupported:
                  typeof currentBrowser.captureVision === "function",
                progress: INITIAL_VISION_PROGRESS,
              };
          } catch {
            signal.throwIfAborted();
          }
        }
        signal.throwIfAborted();
        return visionReply(!!visionFallback);
      }
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
            : signal.aborted
              ? "canceled_while_solving"
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
      if (
        releaseManaged &&
        !managedDelivered &&
        !awaitingDecision &&
        !signal.aborted
      )
        await releaseManaged().catch(() => undefined);
      active = false;
    }
  };
  return Object.assign(check, {
    captureVisionCommand: async (command: string, signal?: AbortSignal) => {
      if (!visionFallback?.captureSupported || visionFallback.completed) return;
      const request = visionScreenshotRequest(command);
      if (!request) {
        const hint = getStandaloneScreenshotHint(command);
        if (!hint) return;
        return {
          result: {
            exitCode: 1,
            output:
              "No commands were executed. Keep the checkbox click separate from its screenshot.",
            browserChallenge: {
              status: "vision_capture_preparation_required",
              visionFallbackAvailable: true,
              message: `Run the screenshot alone: ${hint}. No scrolling, --full, selector crop, pipes or appended commands.`,
            },
          },
        };
      }
      if (request.sessionName !== visionFallback.sessionName) {
        visionFallback.stopped ??= "vision_page_changed";
        return {
          result: {
            exitCode: 1,
            output: "",
            browserChallenge: {
              status: "handoff_required",
              reason: "vision_page_changed",
              visionFallbackAvailable: false,
            },
          },
        };
      }
      const result = await check(
        signal,
        visionFallback.target,
        "capture",
        ownedVisionRequest(visionFallback),
        request.path,
      );
      if (
        result.status !== "vision_capture_ready" &&
        result.status !== "no_pending_challenge" &&
        result.status !== "busy" &&
        visionFallback
      )
        visionFallback.stopped ??=
          result.status === "page_changed"
            ? "vision_page_changed"
            : "vision_capture_unavailable";
      const capture = (result as { capture?: VisionCapture }).capture;
      const focused =
        capture && "focused" in capture ? capture.focused : undefined;
      return {
        result: {
          exitCode: ["vision_capture_ready", "no_pending_challenge"].includes(
            result.status,
          )
            ? 0
            : 1,
          output:
            result.status === "vision_capture_ready"
              ? focused
                ? `Screenshot saved to ${request.path}. Focused challenge image saved to ${focused.path}; view that path once and map its pixels with capture.focused.`
                : `Screenshot saved to ${request.path}. No focused image is available; view this screenshot and map its pixels with capture.devicePixelRatio.`
              : result.status === "no_pending_challenge"
                ? "No challenge remains pending. Inspect the website result before any authorized form action."
                : result.status === "busy"
                  ? "Another owned browser operation is active; use its result instead of requesting another capture."
                  : "The whole challenge could not be captured safely. Stop recapturing and request manual verification.",
          browserChallenge: result,
        },
      };
    },
    guardVisionCommand: (command: string) => {
      if (
        !visionFallback ||
        visionFallback.completed ||
        !visionFallback.stopped
      )
        return;
      // After recovery stops allow only observation, explicit release (routed
      // before this guard), and exact owned-session cleanup. Never execute
      // another screenshot/click/crop or a possible form resubmission.
      if (
        isAgentBrowserSnapshotCommand(command) ||
        command.trim() ===
          `agent-browser --session ${visionFallback.sessionName} close`
      )
        return;
      return {
        status: "handoff_required",
        reason: "vision_recovery_stopped",
        visionFallbackAvailable: false,
        message:
          "Native vision recovery has ended for this challenge. This command was not executed. Stop solving; only a standalone snapshot to inspect the current result, exact session close, runtime release or human handoff is permitted. Do not create another paid task.",
      };
    },
    finishVisionCommand: (command: string, succeeded: boolean) => {
      if (!visionFallback) return;
      if (
        succeeded &&
        command.trim() ===
          `agent-browser --session ${visionFallback.sessionName} close`
      ) {
        visionFallback = undefined;
        return;
      }
      // Failed commands may still have reached the page, so count them too.
      if (
        visionFallback.completed &&
        !isAgentBrowserSnapshotCommand(command) &&
        !visionScreenshotRequest(command)
      )
        visionFallback.actedAfterCompletion = true;
    },
    inspect: (signal?: AbortSignal, target?: Target) =>
      check(signal, target, "inspect"),
    request: (
      action: "solve" | "release",
      sessionName: string,
      signal?: AbortSignal,
    ) => {
      if (!pendingRequest || pendingRequest.target.sessionName !== sessionName)
        return Promise.resolve({
          status: "snapshot_required",
          message:
            "Take a standalone snapshot of this owned session first. No paid solve was attempted.",
        });
      const expected = pendingRequest;
      pendingRequest = undefined;
      return check(signal, expected.target, action, expected);
    },
    /** Records observed feedback only; never loads or reserves a provider. */
    reportProgress: (
      sessionName: string,
      report: VisionProgressReport | undefined,
      signal?: AbortSignal,
    ) =>
      visionFallback?.sessionName === sessionName
        ? check(
            signal,
            visionFallback.target,
            "progress",
            ownedVisionRequest(visionFallback),
            undefined,
            report,
          )
        : Promise.resolve({
            status: "unavailable",
            message:
              "No native vision recovery is active in this session. Nothing was recorded.",
          }),
    getReceiptPrompt: () =>
      providerAttemptStarted
        ? `\n<captcha_runtime_receipt>\nAuthoritative receipt for this run, refreshed by the runtime. Provider: 2Captcha. Paid task creation: ${providerTaskCreated ? "confirmed, exactly one task" : "outcome unknown; do not retry"}. Provider cost: ${knownCostDollars === undefined ? "unknown, never report zero" : `${knownCostDollars} USD`}. Response delivery: ${deliveryOutcome}.${providerUnsolvable ? " Provider outcome: confirmed unsolvable. Any subsequent native vision completion is a separate result, not a provider solve." : ""}${visionFallback ? (visionFallback.completed ? " No pending challenge was observed. Native completion is not website acceptance; verify it from page evidence and never resubmit an uncertain form." : visionFallback.stopped ? " Native vision recovery has ended for this challenge; request manual verification or inspect/close only." : ` Native vision recovery remains available in the same owned session and widget. Report the next Next/Verify result as --attempt ${visionFallback.progress.nextAttempt}; rejected verifications so far: ${visionFallback.progress.rejected} of ${VISION_REJECTION_LIMIT}. Request manual verification when feedback is uncertain.`) : providerUnsolvable ? " Native recovery is unavailable or ended; do not restart it in another session." : ""}${managedGateOutcome ? ` Managed gate at the post-delivery check: ${managedGateOutcome}.` : ""}\nUse these exact provider/task/cost facts in the final recap; do not substitute model API costs or invent providers, amounts, task IDs or URLs. Repeated receipt text is the same task, not an additional charge. Delivery does not prove form submission or website acceptance; report those only from observed page evidence. No second paid attempt.\n</captcha_runtime_receipt>\n`
        : "",
  });
}
