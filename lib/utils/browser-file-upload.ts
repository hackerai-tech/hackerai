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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => request.abort(), 5 * 60_000);
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
