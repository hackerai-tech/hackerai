import {
  isCancellationReasonCategory,
  isCancellationReasonSubcategory,
  isCancellationReasonSubcategoryForCategory,
  normalizeCancellationReasonDetails,
  type CancellationReasonCategory,
  type CancellationReasonSubcategory,
} from "@/lib/billing/cancellation-reasons";

export type CancellationReasonInputLike = {
  reasonCategory?: unknown;
  reasonSubcategory?: unknown;
  reasonDetails?: unknown;
};

export type ParsedCancellationReasonInput = {
  reasonCategory: CancellationReasonCategory;
  reasonSubcategory: CancellationReasonSubcategory;
  reasonDetails: string;
};

export const CANCELLATION_REASON_INPUT_ERRORS = {
  missingCategory: "Please select the main cancellation reason",
  missingSubcategory: "Please select what best describes the issue",
  missingDetails: "Please write a cancellation reason before continuing",
} as const;

/** Validate the cancellation survey payload shared by cancel and retention offers. */
export function parseCancellationReasonInput(
  value: CancellationReasonInputLike | undefined,
): ParsedCancellationReasonInput {
  const reasonCategory = value?.reasonCategory;
  const reasonSubcategory = value?.reasonSubcategory;
  const reasonDetails = normalizeCancellationReasonDetails(
    value?.reasonDetails,
  );

  if (!isCancellationReasonCategory(reasonCategory)) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingCategory);
  }

  if (
    !isCancellationReasonSubcategory(reasonSubcategory) ||
    !isCancellationReasonSubcategoryForCategory(
      reasonCategory,
      reasonSubcategory,
    )
  ) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingSubcategory);
  }

  if (!reasonDetails) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingDetails);
  }

  return {
    reasonCategory,
    reasonSubcategory,
    reasonDetails,
  };
}

/** Map the in-app reason onto Stripe's fixed cancellation feedback enum. */
export function stripeCancellationFeedback(
  reasonCategory: CancellationReasonCategory,
):
  | "too_expensive"
  | "missing_features"
  | "switched_service"
  | "unused"
  | "other" {
  if (reasonCategory === "too_expensive") return "too_expensive";
  if (reasonCategory === "missing_feature") return "missing_features";
  if (reasonCategory === "switched_tool") return "switched_service";
  if (reasonCategory === "not_using_enough") return "unused";
  if (reasonCategory === "temporary_pause") return "unused";
  return "other";
}
