/**
 * Workflow `"use step"` wrappers around the shared web impl in
 * `lib/ai/tools/utils/web-impl.ts`. Both the AI-SDK web factories and these
 * steps return identical response shapes — the impl is the single source
 * of truth.
 */
import {
  webSearchImpl,
  openUrlImpl,
  type WebSearchTimeFilter,
} from "@/lib/ai/tools/utils/web-impl";

export async function webSearchStep(args: {
  queries: string[];
  time?: WebSearchTimeFilter;
  userLocationCountry?: string;
}) {
  "use step";
  return webSearchImpl(args);
}

export async function openUrlStep(args: { url: string }) {
  "use step";
  return openUrlImpl(args);
}
