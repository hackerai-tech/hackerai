import type { ChatMode } from "@/types/chat";

// Keep signed URLs and transfer state in memory, outside persisted drafts.
export interface BrowserUploadTransfer {
  mode: ChatMode;
  controller: AbortController;
  running: boolean;
  retryable: boolean;
  reservation?: { uploadUrl: string; s3Key: string };
}

export const browserUploadTransfers = new WeakMap<
  File,
  BrowserUploadTransfer
>();

// Concurrent reservations for one user contend on the same storage records, so
// the page sends them one at a time. Only the presign request is serialized;
// transfers and metadata saves still run in parallel.
let reservationActive = false;
const reservationWaiters = new Set<() => void>();

function startNextReservation() {
  const next = reservationWaiters.values().next();
  if (next.done) return;
  reservationWaiters.delete(next.value);
  next.value();
}

/**
 * Sends `request` once every earlier reservation on this page has settled.
 * Work still waiting is discarded, and never sent, when any signal aborts;
 * a request already sent keeps its slot until its own promise settles.
 */
export function queueUploadReservation<T>(
  request: () => Promise<T>,
  signals: readonly AbortSignal[],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abortedSignal = signals.find((signal) => signal.aborted);
    if (abortedSignal) {
      reject(abortedSignal.reason);
      return;
    }
    let removeListeners = () => {};
    const start = () => {
      removeListeners();
      reservationActive = true;
      let result: Promise<T>;
      try {
        result = Promise.resolve(request());
      } catch (error) {
        result = Promise.reject(error);
      }
      const release = () => {
        reservationActive = false;
        startNextReservation();
      };
      result.then(release, release);
      resolve(result);
    };
    if (!reservationActive) {
      start();
      return;
    }
    reservationWaiters.add(start);
    const listeners = signals.map((signal) => {
      const discard = () => {
        if (!reservationWaiters.delete(start)) return;
        removeListeners();
        reject(signal.reason);
      };
      signal.addEventListener("abort", discard, { once: true });
      return () => signal.removeEventListener("abort", discard);
    });
    removeListeners = () => listeners.forEach((remove) => remove());
  });
}

export class UploadTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UploadTransportError";
  }
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      window.removeEventListener("online", resume);
    };
    const resume = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(
      resume,
      navigator.onLine === false ? 10_000 : delay,
    );
    signal.addEventListener("abort", abort, { once: true });
    window.addEventListener("online", resume, { once: true });
    if (signal.aborted) abort();
  });
}

export async function putBrowserFile(
  file: File,
  uploadUrl: string,
  signal: AbortSignal,
): Promise<void> {
  // Allow slower large transfers while keeping every attempt finite.
  const timeoutMs = Math.min(
    75 * 60_000,
    Math.max(5 * 60_000, Math.ceil(file.size / (64 * 1024)) * 1_000),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => request.abort(), timeoutMs);
    try {
      const response = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
        signal: request.signal,
      });
      if (response.ok) return;
      throw new UploadTransportError(
        response.status === 403
          ? "Upload access expired or was denied. Remove and attach the file again."
          : `Failed to upload file ${file.name} (HTTP ${response.status}).`,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      );
    } catch (error) {
      signal.throwIfAborted();
      const failure =
        error instanceof UploadTransportError
          ? error
          : new UploadTransportError(
              "Upload connection interrupted. Please retry.",
              true,
            );
      if (!failure.retryable || attempt === 2) throw failure;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
    await waitForRetry(1_000 * (attempt + 1), signal);
  }
}
