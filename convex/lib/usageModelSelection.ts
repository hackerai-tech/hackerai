import { v, type Infer } from "convex/values";

export const usageSelectedModelValidator = v.union(
  v.literal("auto"),
  v.literal("hackerai-standard"),
  v.literal("hackerai-pro"),
  v.literal("hackerai-max"),
);

/**
 * The product mode accepted for one usage row and the routes it ran on.
 * `fallback_model` is present only when the run observed an explicit
 * alternate route or a confirmed provider fallback; it is never inferred from
 * the stored `model`, the subscription or normal Auto routing.
 */
export const usageModelSelectionValidator = v.object({
  selected: usageSelectedModelValidator,
  initial_model: v.string(),
  fallback_model: v.optional(v.string()),
});

export type UsageModelSelection = Infer<typeof usageModelSelectionValidator>;

const SELECTED_MODEL_LABELS: Record<UsageModelSelection["selected"], string> = {
  auto: "Auto",
  "hackerai-standard": "Standard",
  "hackerai-pro": "Pro",
  "hackerai-max": "Max",
};

/**
 * Sticky, run-scoped record of a proven fallback route for the usage ledger.
 * The app's shared stream runner keeps it across steps, retries and usage
 * resets. It is reporting only and never changes routing.
 */
export type ObservedModelFallback = {
  model: string;
  /** An explicit alternate request not yet confirmed by a served step. */
  awaitingServedModel: boolean;
};

/**
 * A caller explicitly requested a different route (or a different provider
 * for the same model). Records the exact requested model ID until a served
 * step refines it. Same-route retries must not call this.
 */
export const recordRequestedModelFallback = (
  current: ObservedModelFallback | undefined,
  requestedModelId: string,
): ObservedModelFallback | undefined =>
  requestedModelId
    ? { model: requestedModelId, awaitingServedModel: true }
    : current;

/**
 * Observes one served model step. Only a confirmed provider fallback, or the
 * first served step after an explicit alternate request, changes the record.
 * Normal routing and model-ID differences alone never create a fallback.
 */
export const observeServedModelFallback = (
  current: ObservedModelFallback | undefined,
  {
    servedModel,
    confirmedProviderFallback,
  }: { servedModel?: string; confirmedProviderFallback: boolean },
): ObservedModelFallback | undefined => {
  if (!servedModel) return current;
  if (confirmedProviderFallback || current?.awaitingServedModel) {
    return { model: servedModel, awaitingServedModel: false };
  }
  return current;
};

/**
 * Usage-history label. Rows without a stored selection keep their model text;
 * only the canonical stored `auto` is capitalized.
 */
export const getUsageModelLabel = (
  model: string,
  selection: Pick<UsageModelSelection, "selected"> | undefined,
): string => {
  if (selection) return SELECTED_MODEL_LABELS[selection.selected];
  return model === "auto" ? SELECTED_MODEL_LABELS.auto : model;
};
