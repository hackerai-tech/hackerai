"use client";

import { v4 as uuidv4 } from "uuid";
import { captureQueuedAuthenticatedEvent } from "./client";
import { isTauriEnvironment } from "@/app/hooks/useTauri";

/**
 * Files panel adoption and outcome telemetry. Properties are closed enums and
 * timings only: never names, paths, IDs, URLs, error text or file content.
 */
type EntryPoint = "computer_files" | "other";
type PreviewKind = "saved_attachment" | "captured_result" | "live_workspace";
type DownloadKind = PreviewKind | "workspace_snapshot";

type WorkspaceFilesEvents = {
  /** Computer became visible with the permanent Files tab offered. */
  workspace_files_exposed: Record<string, never>;
  /** The Files tab first became visible in a mounted chat workspace. */
  workspace_files_viewed: Record<string, never>;
  /** Format-unsupported previews and intentional aborts are not reported. */
  workspace_file_preview: {
    outcome: "success" | "failed" | "unavailable";
    file_kind: PreviewKind;
    entry_point: EntryPoint;
    duration_ms?: number;
  };
  /**
   * `initiated` is a browser anchor download that cannot be confirmed;
   * `success` is a confirmed native or File System Access save. duration_ms is
   * click to outcome and can include time spent in a save dialog.
   */
  workspace_file_download: {
    outcome: "success" | "initiated" | "canceled" | "failed";
    source: "chat" | "workspace";
    file_kind: DownloadKind;
    entry_point: EntryPoint;
    reason?: "unsupported_native" | "unavailable";
    duration_ms?: number;
  };
};

const MAX_DURATION_MS = 600_000;

export function telemetryNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Whole milliseconds since `start`, capped; undefined when not measurable. */
export function elapsedMs(start: number | undefined) {
  if (start === undefined) return undefined;
  const elapsed = Math.round(telemetryNow() - start);
  return Number.isFinite(elapsed) && elapsed >= 0
    ? Math.min(elapsed, MAX_DURATION_MS)
    : undefined;
}

export function trackWorkspaceFiles<E extends keyof WorkspaceFilesEvents>(
  event: E,
  properties: WorkspaceFilesEvents[E],
) {
  try {
    const safe: Record<string, unknown> = {
      ...properties,
      telemetry_version: 1,
      surface: isTauriEnvironment() ? "desktop" : "web",
    };
    for (const key of Object.keys(safe))
      if (safe[key] === undefined) delete safe[key];
    return captureQueuedAuthenticatedEvent({
      event,
      properties: safe,
      // Opaque per-event key: retries of the same capture deduplicate, while
      // callers own once-per-mount semantics.
      dedupeKey: uuidv4(),
    });
  } catch {
    // Telemetry cannot interrupt file browsing or saving.
    return false;
  }
}
