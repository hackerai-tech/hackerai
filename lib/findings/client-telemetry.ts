"use client";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import { findingEventProperties, type FindingEvent } from "./telemetry";

export function captureFindingEvent(event: FindingEvent) {
  try {
    captureAuthenticatedEvent("finding_operation_completed", {
      ...findingEventProperties(event),
      client: isTauriEnvironment() ? "desktop" : "web",
    });
  } catch {
    // Analytics must not interrupt report actions.
  }
}
