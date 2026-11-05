// Applied after PostHog adds browser defaults and registered properties. Keep
// diagnostics useful without inheriting URLs, attribution, or user content.
const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$lib",
  "$lib_version",
  "performance_event_version",
  "telemetry_sample_rate",
  "sample_id",
  "chat_id",
  "trigger_run_id",
  "mode",
  "outcome",
  "duration_ms",
  "first_visible_text_ms",
  "visible_text_observed",
  "max_visible_text_gap_ms",
  "visible_text_gap_ge5s_count",
  "visible_text_update_count",
  "trailing_text_wait_ms",
  "backgrounded",
  "measurement",
  "input_count",
  "input_frame_delay_max_ms",
  "scroll_count",
  "scroll_frame_gap_max_ms",
  "long_task_count",
  "long_task_total_ms",
  "long_task_max_ms",
  "event_timing_entry_count",
  "event_timing_duration_max_ms",
  "observation_ms",
  "long_task_supported",
  "event_timing_supported",
  "route_kind",
]);

export function sanitizeChatPerformanceEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  if (
    (event.event !== "chat_visible_response_performance" &&
      event.event !== "chat_browser_responsiveness") ||
    !event.properties
  )
    return event;
  event.properties = Object.fromEntries(
    Object.entries(event.properties).filter(([key]) =>
      ALLOWED_PROPERTIES.has(key),
    ),
  );
  delete event.$set;
  delete event.$set_once;
  return event;
}
