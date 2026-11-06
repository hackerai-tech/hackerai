import { z } from "zod";
import { abortableDelay } from "@/lib/utils/abortable-delay";
import { isSupportedCaptchaTarget, type CaptchaWidget } from "./detection";

const providerResponse = z.object({
  errorId: z.number().int(),
  taskId: z.number().int().positive().optional(),
  status: z.enum(["processing", "ready"]).optional(),
  solution: z
    .object({
      gRecaptchaResponse: z.string().min(1).max(16384).optional(),
      token: z.string().min(1).max(16384).optional(),
      userAgent: z
        .string()
        .min(1)
        .max(1024)
        .regex(/^[\x20-\x7e]+$/)
        .optional(),
    })
    .optional(),
  cost: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
});

export type CaptchaSolution = {
  token: string;
  costDollars: number;
  userAgent?: string;
};
class RetryableCaptchaPollError extends Error {}
export interface CaptchaSolver {
  solve(
    url: string,
    widget: CaptchaWidget,
    signal: AbortSignal,
    onTaskCreated?: (taskId: number) => void | Promise<void>,
    onCostKnown?: (taskId: number, costDollars: number) => Promise<void>,
  ): Promise<CaptchaSolution>;
}

/** Fixed provider origin; no caller-controlled endpoints or paid-task retries. */
export function createTwoCaptchaSolver(apiKey: string): CaptchaSolver {
  return {
    async solve(url, widget, signal, onTaskCreated, onCostKnown) {
      if (
        !apiKey ||
        !isSupportedCaptchaTarget(url, widget) ||
        !/^[A-Za-z0-9_-]{10,256}$/.test(widget.siteKey) ||
        widget.invisible
      )
        throw new Error("CAPTCHA provider or challenge is unsupported.");
      // hCaptcha can still be processing after three minutes. Continue polling
      // that same paid task within a five-minute wall-clock bound; never create
      // a replacement task. Other challenges retain their three-minute bound.
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(widget.kind === "hcaptcha" ? 300_000 : 180_000),
      ]);
      const request = async (
        method: "createTask" | "getTaskResult",
        payload: Record<string, unknown>,
      ) => {
        deadline.throwIfAborted();
        let transient = true;
        try {
          const response = await fetch(`https://api.2captcha.com/${method}`, {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, ...payload }),
            signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
          });
          transient = response.status === 429 || response.status >= 500;
          if (!response.ok) throw new Error();
          transient = true;
          const body = await response.json();
          transient = false;
          const parsed = providerResponse.safeParse(body);
          if (!parsed.success || parsed.data.errorId !== 0) throw new Error();
          return parsed.data;
        } catch (error) {
          deadline.throwIfAborted();
          if (
            method === "getTaskResult" &&
            transient &&
            !(error instanceof SyntaxError)
          )
            throw new RetryableCaptchaPollError("CAPTCHA result read failed.");
          // Provider/network errors can contain credentials or response tokens.
          throw new Error(
            "CAPTCHA provider request failed. Do not automatically retry.",
          );
        }
      };
      // Never retry task creation: a lost response may already have incurred cost.
      const created = await request("createTask", {
        task: {
          type:
            widget.kind === "recaptcha_v2"
              ? "RecaptchaV2TaskProxyless"
              : widget.kind === "hcaptcha"
                ? "HCaptchaTaskProxyless"
                : "TurnstileTaskProxyless",
          websiteURL: url,
          websiteKey: widget.siteKey,
          ...(widget.managed && {
            action: widget.managed.action,
            data: widget.managed.data,
            pagedata: widget.managed.pagedata,
          }),
        },
      });
      if (!created.taskId)
        throw new Error("CAPTCHA provider returned no task identity.");
      // Cancellation cannot cancel a provider's already-created task. Preserve
      // its billing identity for reconciliation even if polling never finishes.
      if (onTaskCreated) {
        for (let attempt = 0; ; attempt++) {
          try {
            // Start registration even if cancellation raced with creation: its
            // identity is still needed for billing. Bound only our wait; the
            // idempotent write can finish after cancellation for reconciliation.
            const registration = Promise.resolve(onTaskCreated(created.taskId));
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(deadline.reason);
              if (deadline.aborted) abort();
              else deadline.addEventListener("abort", abort, { once: true });
              registration.then(
                () => {
                  deadline.removeEventListener("abort", abort);
                  resolve();
                },
                (error) => {
                  deadline.removeEventListener("abort", abort);
                  reject(error);
                },
              );
            });
            break;
          } catch (error) {
            // Registration is idempotent; creation is never repeated.
            deadline.throwIfAborted();
            if (attempt >= 2) throw error;
            await abortableDelay(500 * (attempt + 1), deadline);
          }
        }
      }
      let consecutivePollFailures = 0;
      for (;;) {
        await abortableDelay(5000, deadline);
        let result;
        try {
          result = await request("getTaskResult", { taskId: created.taskId });
          consecutivePollFailures = 0;
        } catch (error) {
          // Reading an existing task cannot create another charge. Retry only
          // transport errors, 429 or 5xx, at most twice consecutively and always
          // inside the same deadline. Provider errors and malformed data fail.
          if (
            error instanceof RetryableCaptchaPollError &&
            ++consecutivePollFailures <= 2
          )
            continue;
          throw error;
        }
        if (result.status === "processing") continue;
        const token =
          widget.kind === "recaptcha_v2" || widget.kind === "hcaptcha"
            ? result.solution?.gRecaptchaResponse
            : result.solution?.token;
        const costDollars = Number(result.cost);
        if (
          result.status === "ready" &&
          Number.isFinite(costDollars) &&
          costDollars >= 0 &&
          costDollars <= 1
        )
          await onCostKnown?.(created.taskId, costDollars);
        if (
          result.status !== "ready" ||
          !token ||
          (widget.managed && !result.solution?.userAgent) ||
          !Number.isFinite(costDollars) ||
          costDollars < 0 ||
          costDollars > 1
        )
          throw new Error("CAPTCHA provider returned an invalid solution.");
        return {
          token,
          costDollars,
          ...(widget.managed && { userAgent: result.solution!.userAgent }),
        };
      }
    },
  };
}
