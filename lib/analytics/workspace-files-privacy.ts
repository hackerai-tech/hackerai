const workspaceFilesEvents = new Set([
  "workspace_files_exposed",
  "workspace_files_viewed",
  "workspace_file_preview",
  "workspace_file_download",
]);

const allowedProperties = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "telemetry_version",
  "surface",
  "source",
  "file_kind",
  "entry_point",
  "outcome",
  "reason",
  "duration_ms",
]);

/** Keep SDK identity and the Files event contract. Strip URLs and profile data. */
export function sanitizeWorkspaceFilesEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  if (!event.event || !workspaceFilesEvents.has(event.event)) return event;

  if (event.properties) {
    event.properties = Object.fromEntries(
      Object.entries(event.properties).filter(([key]) =>
        allowedProperties.has(key),
      ),
    );
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
