import type { ChatMode } from "@/types/chat";

/** The committed account and organization an upload was started under. */
export interface UploadScope {
  userId: string | null;
  organizationId: string | null;
}

// Keep signed URLs and transfer state in memory, outside persisted drafts.
export interface BrowserUploadTransfer {
  mode: ChatMode;
  controller: AbortController;
  running: boolean;
  retryable: boolean;
  reservation?: { uploadUrl: string; s3Key: string };
  // The scope the reservation was signed for; a retry never crosses it.
  reservationScope?: UploadScope;
}

export const browserUploadTransfers = new WeakMap<
  File,
  BrowserUploadTransfer
>();

/** Calls `onAbort` once for the first signal that aborts; returns a remover. */
function listenForAbort(
  signals: readonly AbortSignal[],
  onAbort: (reason: unknown) => void,
): () => void {
  const removers = signals.map((signal) => {
    const abort = () => {
      remove();
      onAbort(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  });
  const remove = () => removers.forEach((removeListener) => removeListener());
  return remove;
}

const firstAbortReason = (signals: readonly AbortSignal[]) =>
  signals.find((signal) => signal.aborted);

/**
 * Waits for a shared lookup such as the storage region, but stops waiting as
 * soon as this transfer or its scope aborts. The shared promise is untouched.
 */
export function waitUnlessAborted<T>(
  promise: Promise<T>,
  signals: readonly AbortSignal[],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = firstAbortReason(signals);
    if (aborted) {
      reject(aborted.reason);
      return;
    }
    const remove = listenForAbort(signals, reject);
    promise.then(
      (value) => {
        remove();
        resolve(value);
      },
      (error) => {
        remove();
        reject(error);
      },
    );
  });
}

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
    const aborted = firstAbortReason(signals);
    if (aborted) {
      reject(aborted.reason);
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
    removeListeners = listenForAbort(signals, (reason) => {
      if (reservationWaiters.delete(start)) reject(reason);
    });
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

function waitForRetry(
  delay: number,
  signals: readonly AbortSignal[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = firstAbortReason(signals);
    if (aborted) {
      reject(aborted.reason);
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      removeAbort();
      window.removeEventListener("online", resume);
    };
    const resume = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(
      resume,
      navigator.onLine === false ? 10_000 : delay,
    );
    const removeAbort = listenForAbort(signals, (reason) => {
      cleanup();
      reject(reason);
    });
    window.addEventListener("online", resume, { once: true });
  });
}

/** PUTs the file with bounded retries while the transfer and sign-in scope are active. */
export async function putBrowserFile(
  file: File,
  uploadUrl: string,
  signal: AbortSignal,
  scopeSignal?: AbortSignal,
): Promise<void> {
  const stopSignals = scopeSignal ? [signal, scopeSignal] : [signal];
  // Allow slower large transfers while keeping every attempt finite.
  const timeoutMs = Math.min(
    75 * 60_000,
    Math.max(5 * 60_000, Math.ceil(file.size / (64 * 1024)) * 1_000),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    scopeSignal?.throwIfAborted();
    const request = new AbortController();
    const removeAbort = listenForAbort(stopSignals, (reason) =>
      request.abort(reason),
    );
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
      scopeSignal?.throwIfAborted();
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
      removeAbort();
    }
    await waitForRetry(1_000 * (attempt + 1), stopSignals);
  }
}
