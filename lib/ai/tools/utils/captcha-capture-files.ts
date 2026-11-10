import { posix } from "node:path";
import type { ToolContext } from "@/types";

type CaptureResult = Awaited<
  ReturnType<NonNullable<ToolContext["captureCaptchaVisionCommand"]>>
>;
// Retain failed outcomes for this run so an old file cannot masquerade as a
// successful capture. Unmanaged screenshots keep their existing file behavior.
const captures = new WeakMap<
  ToolContext,
  Map<string, Promise<boolean | undefined>>
>();
const key = (path: string) => posix.normalize(path);

export async function trackCaptchaCapture(
  context: ToolContext,
  path: string,
  execute: () => Promise<CaptureResult>,
): Promise<CaptureResult> {
  let paths = captures.get(context);
  if (!paths) captures.set(context, (paths = new Map()));
  let finish!: (ready: boolean | undefined) => void;
  paths.set(
    key(path),
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  try {
    const result = await execute();
    const challenge = result?.result.browserChallenge;
    finish(
      result === undefined
        ? undefined
        : !!challenge &&
            typeof challenge === "object" &&
            "status" in challenge &&
            challenge.status === "vision_capture_ready",
    );
    return result;
  } catch (error) {
    finish(false);
    throw error;
  }
}

export async function waitForCaptchaCapture(
  context: ToolContext,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const pending = captures.get(context)?.get(key(path));
  if (!pending) return;
  if (signal?.aborted) throw new Error("CAPTCHA image view canceled.");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("CAPTCHA image view canceled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    const ready = await Promise.race([pending, aborted]);
    if (signal?.aborted) throw new Error("CAPTCHA image view canceled.");
    if (ready === false)
      throw new Error(
        "The CAPTCHA screenshot was not qualified. Do not use an older image.",
      );
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
