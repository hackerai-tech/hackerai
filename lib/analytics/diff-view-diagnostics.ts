"use client";

import { v4 as uuidv4 } from "uuid";
import {
  captureQueuedAuthenticatedEvent,
  getPermittedAnalyticsUserId,
} from "./client";

type ViewMode = "diff" | "original" | "modified";
type Fact =
  | { stage: "computed" }
  | {
      stage: "view_rendered";
      view_mode: ViewMode;
      instance_observed_computed_before_view: boolean;
    }
  | {
      stage: "first_modified_editor_disposed";
      instance_observed_computed_before_disposal: boolean;
      modified_editor_disposed_at: number;
    };

/** Five consent-permitted lifetime facts, not file success or viewport exposure. */
export function createDiffViewDiagnostics() {
  const facts = new Map<string, Fact>();
  const queued = new Set<string>();
  let identity: string | undefined;
  let instanceId: string | undefined;
  let retired = false;

  /** Queue acknowledgment is not delivery; never link an instance across accounts. */
  const retry = () => {
    try {
      const currentIdentity = getPermittedAnalyticsUserId();
      if (identity && currentIdentity !== identity) {
        retired = true;
        facts.clear();
      }
      if (retired || !currentIdentity) return;
      identity ??= currentIdentity;
      if (facts.size === 0) return;
      instanceId ??= uuidv4();
      const build = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      for (const [key, fact] of facts) {
        if (queued.has(key)) continue;
        if (
          captureQueuedAuthenticatedEvent({
            event: "diff_view_diagnostic",
            dedupeKey: `${instanceId}:${key}`,
            properties: {
              diagnostic_version: 1,
              diff_view_instance_id: instanceId,
              ...fact,
              hackerai_frontend_build_commit:
                build && /^[a-f0-9]{40}$/i.test(build)
                  ? build.toLowerCase()
                  : "unknown",
            },
          })
        )
          queued.add(key);
      }
    } catch {
      // UUID creation and analytics cannot interrupt the editor or its teardown.
    }
  };

  const observe = (key: string, fact: Fact) => {
    if (retired || facts.has(key)) return;
    // SDK readiness may lag consent. Never retain pre-permission activity to
    // backfill after an opt-in; the existing queue handles permitted SDK delay.
    if (!getPermittedAnalyticsUserId()) return;
    facts.set(key, fact);
    retry();
  };

  return {
    retry,
    computed: () => observe("computed", { stage: "computed" }),
    // The first editor teardown only; remounts share this component instance.
    modifiedEditorDisposed: () =>
      observe("first_modified_editor_disposed", {
        stage: "first_modified_editor_disposed",
        instance_observed_computed_before_disposal: facts.has("computed"),
        // Queue delivery may lag observation; retain the client clock separately.
        modified_editor_disposed_at: Date.now(),
      }),
    viewRendered: (view: ViewMode) =>
      observe(`view:${view}`, {
        stage: "view_rendered",
        view_mode: view,
        instance_observed_computed_before_view: facts.has("computed"),
      }),
  };
}
