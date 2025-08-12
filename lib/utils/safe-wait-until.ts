import { waitUntil } from "@vercel/functions";

/**
 * Safely wraps work in try-catch and executes it with waitUntil
 * This ensures background tasks are properly logged if they fail
 *
 * @param work - The async function to execute in the background
 * @returns void
 */
export function safeWaitUntil(promise: Promise<unknown>) {
  const doWork = async () => {
    try {
      await promise.catch((e) => {
        console.error("[SAFE WAIT UNTIL] Caught error", e);
      });
    } catch (error) {
      console.error("[SAFE WAIT UNTIL] Error", error);
    }
  };

  waitUntil(doWork());
}
