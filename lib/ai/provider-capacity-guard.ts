import { wrapLanguageModel, type LanguageModel } from "ai";

/** Guard each SDK adapter attempt, including attempts below recovery middleware. */
export const withProviderCapacityCheck = (
  model: LanguageModel,
  checkCapacity?: () => Promise<void>,
): LanguageModel => {
  if (
    !checkCapacity ||
    typeof model === "string" ||
    model.specificationVersion !== "v3"
  ) {
    return model;
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }) => {
        await checkCapacity();
        return params;
      },
    },
  });
};
