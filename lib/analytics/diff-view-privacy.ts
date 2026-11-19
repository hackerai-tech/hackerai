const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "diagnostic_version",
  "diff_view_instance_id",
  "stage",
  "view_mode",
  "instance_observed_computed_before_view",
  "instance_observed_computed_before_disposal",
  "modified_editor_disposed_at",
  "hackerai_frontend_build_commit",
]);

/** Drop SDK-enriched URLs and profile/content fields from the bounded diagnostic. */
export function sanitizeDiffViewEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  if (event.event !== "diff_view_diagnostic") return event;
  if (event.properties)
    event.properties = Object.fromEntries(
      Object.entries(event.properties).filter(([key]) =>
        ALLOWED_PROPERTIES.has(key),
      ),
    );
  delete event.$set;
  delete event.$set_once;
  return event;
}
