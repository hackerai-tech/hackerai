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
    })
    .optional(),
  cost: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
});

export type CaptchaSolution = { token: string; costDollars: number };
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
        try {
          const response = await fetch(`https://api.2captcha.com/${method}`, {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, ...payload }),
            signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
          });
          if (!response.ok) throw new Error();
          const parsed = providerResponse.safeParse(await response.json());
          if (!parsed.success || parsed.data.errorId !== 0) throw new Error();
          return parsed.data;
        } catch {
          deadline.throwIfAborted();
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
        },
      });
      if (!created.taskId)
        throw new Error("CAPTCHA provider returned no task identity.");
      // Cancellation cannot cancel a provider's already-created task. Preserve
      // its billing identity for reconciliation even if polling never finishes.
      if (onTaskCreated) {
        for (let attempt = 0; ; attempt++) {
          try {
            await onTaskCreated(created.taskId);
            break;
          } catch (error) {
            // Registration is idempotent; creation is never repeated.
            if (attempt >= 2) throw error;
            await abortableDelay(500 * (attempt + 1), deadline);
          }
        }
      }
      for (;;) {
        await abortableDelay(5000, deadline);
        const result = await request("getTaskResult", {
          taskId: created.taskId,
        });
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
          !Number.isFinite(costDollars) ||
          costDollars < 0 ||
          costDollars > 1
        )
          throw new Error("CAPTCHA provider returned an invalid solution.");
        return { token, costDollars };
      }
    },
  };
}
