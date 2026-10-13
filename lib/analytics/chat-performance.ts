"use client";

import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "./client";

export type ChatPerformanceOutcome =
  "completed" | "aborted" | "error" | "navigated" | "superseded";
type Sample = {
  owner: string;
  id: string;
  chatId: string;
  mode: string;
  started: number;
  excludedMessageIds: Set<string>;
  firstText: number | null;
  lastText: number | null;
  maxGap: number;
  gaps: number;
  updates: number;
  backgrounded: boolean;
  outcome?: ChatPerformanceOutcome;
  runId?: string;
};

/** Timings only. Never retain or capture message content. One sample per POST. */
export class ChatPerformanceTracker {
  private sample: Sample | null = null;

  start(chatId: string, mode: string, existingAssistantIds: string[]) {
    this.finish("superseded");
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner) return;
    this.sample = {
      owner,
      id: crypto.randomUUID(),
      chatId,
      mode,
      started: performance.now(),
      excludedMessageIds: new Set(existingAssistantIds),
      firstText: null,
      lastText: null,
      maxGap: 0,
      gaps: 0,
      updates: 0,
      backgrounded: document.visibilityState !== "visible",
    };
  }

  get id() {
    return this.sample?.id;
  }

  reconcileIdentity() {
    if (this.sample?.owner !== getIdentifiedAnalyticsUserId())
      this.sample = null;
  }

  accepts(messageId: string) {
    return !!this.sample && !this.sample.excludedMessageIds.has(messageId);
  }

  setOutcome(outcome: ChatPerformanceOutcome) {
    if (this.sample) this.sample.outcome = outcome;
  }

  setRunId(runId: string | null | undefined) {
    if (this.sample && runId) this.sample.runId = runId;
  }

  background() {
    if (!this.sample) return;
    this.sample.backgrounded = true;
    this.sample.lastText = null;
  }

  textPainted(sampleId: string) {
    const sample = this.sample;
    if (
      !sample ||
      sample.id !== sampleId ||
      document.visibilityState !== "visible"
    )
      return;
    const now = performance.now();
    sample.firstText ??= now;
    if (sample.lastText !== null) {
      const gap = now - sample.lastText;
      sample.maxGap = Math.max(sample.maxGap, gap);
      if (gap >= 5000) sample.gaps++;
    }
    sample.lastText = now;
    sample.updates++;
  }

  finish(outcome?: ChatPerformanceOutcome) {
    const sample = this.sample;
    this.sample = null;
    if (!sample || sample.owner !== getIdentifiedAnalyticsUserId()) return;
    captureAuthenticatedEvent("chat_visible_response_performance", {
      performance_event_version: 1,
      sample_id: sample.id,
      chat_id: sample.chatId,
      trigger_run_id: sample.runId,
      mode: sample.mode,
      outcome: outcome ?? sample.outcome ?? "completed",
      duration_ms: Math.round(performance.now() - sample.started),
      first_visible_text_ms:
        sample.firstText === null
          ? null
          : Math.round(sample.firstText - sample.started),
      visible_text_observed: sample.firstText !== null,
      max_visible_text_gap_ms:
        sample.updates >= 2 ? Math.round(sample.maxGap) : null,
      visible_text_gap_ge5s_count: sample.gaps,
      visible_text_update_count: sample.updates,
      trailing_text_wait_ms:
        sample.lastText === null
          ? null
          : Math.round(performance.now() - sample.lastText),
      backgrounded: sample.backgrounded,
      measurement: "dom_commit_after_animation_frame",
      telemetry_sample_rate: 1,
    });
  }
}
