import { schemaTask } from "@trigger.dev/sdk";
import {
  browserlessDemoPayload,
  runBrowserlessDemo,
} from "@/lib/ai/captcha/browserless-demo";

// Explicit internal Preview evaluation. No model, customer URLs, browser
// transport changes, automatic retries, or production execution.
export const browserlessCaptchaDemo = schemaTask({
  id: "browserless-captcha-demo",
  schema: browserlessDemoPayload,
  machine: { preset: "small-1x" },
  maxDuration: 125,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload, { ctx, signal }) => ({
    runtime: {
      environment: ctx.environment.type,
      convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL ?? null,
    },
    result: await runBrowserlessDemo(payload, ctx.environment.type, { signal }),
  }),
});
