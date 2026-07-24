/** Maximum provider silence allowed before the active model request is aborted. */
export const PROVIDER_STREAM_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/** Stable error code used to classify provider inactivity separately from cancellation. */
export const PROVIDER_STREAM_TIMEOUT_CODE = "PROVIDER_STREAM_TIMEOUT";

/** Identifies whether provider activity stopped before or after its first event. */
export type ProviderStreamTimeoutPhase = "first_chunk" | "between_chunks";

/** Typed abort reason that distinguishes provider inactivity from caller cancellation. */
export class ProviderStreamTimeoutError extends Error {
  readonly code = PROVIDER_STREAM_TIMEOUT_CODE;
  readonly phase: ProviderStreamTimeoutPhase;
  readonly timeoutMs: number;

  constructor(args: { phase: ProviderStreamTimeoutPhase; timeoutMs: number }) {
    super(
      `Provider stream timeout after ${args.timeoutMs}ms without activity (${args.phase})`,
    );
    this.name = "ProviderStreamTimeoutError";
    this.phase = args.phase;
    this.timeoutMs = args.timeoutMs;
  }
}

type TimeoutHandle = ReturnType<typeof setTimeout> & {
  unref?: () => void;
};

/** Lifecycle controls for timing provider activity without timing local tools. */
export type ProviderStreamTimeoutGuard = {
  signal: AbortSignal;
  startProviderStep: () => void;
  recordProviderActivity: () => void;
  pauseForToolExecution: () => void;
  finishProviderStep: () => void;
  dispose: () => void;
  getTimeoutError: () => ProviderStreamTimeoutError | undefined;
};

/**
 * AI SDK chunk timeouts are first armed after the SDK receives a stream event
 * and can remain active while a tool executes. Track provider callbacks
 * directly so initial and between-chunk stalls are bounded without putting
 * terminal work on the clock.
 */
export const createProviderStreamTimeoutGuard = (args: {
  externalAbortSignal: AbortSignal;
  onTimeout: (error: ProviderStreamTimeoutError) => void;
  timeoutMs?: number;
}): ProviderStreamTimeoutGuard => {
  const timeoutMs = args.timeoutMs ?? PROVIDER_STREAM_INACTIVITY_TIMEOUT_MS;
  const timeoutController = new AbortController();
  let timeoutHandle: TimeoutHandle | undefined;
  let providerStepActive = false;
  let receivedProviderChunk = false;
  let disposed = false;
  let timeoutError: ProviderStreamTimeoutError | undefined;

  const clearTimeoutHandle = () => {
    if (timeoutHandle === undefined) return;
    clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    providerStepActive = false;
    clearTimeoutHandle();
    args.externalAbortSignal.removeEventListener("abort", dispose);
  };

  const armTimeout = () => {
    clearTimeoutHandle();
    if (disposed || !providerStepActive || args.externalAbortSignal.aborted) {
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (disposed || !providerStepActive || args.externalAbortSignal.aborted) {
        return;
      }

      timeoutError = new ProviderStreamTimeoutError({
        phase: receivedProviderChunk ? "between_chunks" : "first_chunk",
        timeoutMs,
      });
      const error = timeoutError;
      dispose();
      try {
        args.onTimeout(error);
      } finally {
        timeoutController.abort(error);
      }
    }, timeoutMs) as TimeoutHandle;
    timeoutHandle.unref?.();
  };

  args.externalAbortSignal.addEventListener("abort", dispose, { once: true });
  if (args.externalAbortSignal.aborted) {
    dispose();
  }

  return {
    signal: timeoutController.signal,
    startProviderStep: () => {
      if (disposed) return;
      providerStepActive = true;
      receivedProviderChunk = false;
      armTimeout();
    },
    recordProviderActivity: () => {
      if (!providerStepActive || disposed) return;
      receivedProviderChunk = true;
      armTimeout();
    },
    pauseForToolExecution: () => {
      providerStepActive = false;
      clearTimeoutHandle();
    },
    finishProviderStep: () => {
      providerStepActive = false;
      clearTimeoutHandle();
    },
    dispose,
    getTimeoutError: () => timeoutError,
  };
};
