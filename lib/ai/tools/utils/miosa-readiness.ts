import type { Sandbox } from "@miosa/sdk";

const READINESS_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

class MiosaReadinessError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MiosaReadinessError";
  }
}

/**
 * SDK 3.2.3 returns false on the server's 30-second SSE watch timeout even
 * when the caller requested longer. Poll the supported readiness endpoint
 * instead; durable restores currently take longer than that watch window.
 */
export async function waitForMiosaReadiness(sandbox: Sandbox): Promise<void> {
  const deadline = performance.now() + READINESS_TIMEOUT_MS;
  const timeoutError = () =>
    new MiosaReadinessError(
      `MIOSA sandbox ${sandbox.id} did not become ready within 180 seconds`,
      "SANDBOX_READY_TIMEOUT",
      504,
    );
  const assertNotTerminal = (state: unknown) => {
    if (state === "error" || state === "destroyed" || state === "destroying") {
      throw new MiosaReadinessError(
        `MIOSA sandbox ${sandbox.id} entered terminal state: ${state}`,
        "SANDBOX_BOOT_FAILED",
        502,
      );
    }
  };
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeoutError());
    }, READINESS_TIMEOUT_MS);
  });
  const poll = async () => {
    assertNotTerminal(sandbox.state);
    while (!expired && performance.now() < deadline) {
      const readiness = await sandbox.readiness();
      if (expired || performance.now() >= deadline) throw timeoutError();
      assertNotTerminal(readiness.state);
      if (readiness.ready === true) {
        await sandbox.refresh();
        if (expired || performance.now() >= deadline) throw timeoutError();
        assertNotTerminal(sandbox.state);
        // Refresh the SDK's local state before exec; readiness alone does not
        // update the SDK object and a concurrent pause can race this check.
        if (sandbox.state === "running") return;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(POLL_INTERVAL_MS, deadline - performance.now()),
        ),
      );
    }
    throw timeoutError();
  };
  try {
    // Bound even an in-flight SDK request/retry. The expired guard prevents
    // further polling or refreshes if that read completes after our deadline.
    await Promise.race([poll(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
