import "server-only";

import { wrapLanguageModel, type LanguageModel } from "ai";
import { isAbliterationModel } from "@/lib/ai/abliteration";
import { extractErrorDetails } from "@/lib/utils/error-utils";
import type { createAbliterationVisionPreprocessor } from "./abliteration-vision";

/** Retries a rejected native-image request once, preserving its selected model. */
export function createAbliterationMediaRecovery(
  preprocess: ReturnType<typeof createAbliterationVisionPreprocessor>,
  abortSignal: AbortSignal,
) {
  // Shared by every model wrapper in this response/run, including SDK retries.
  let activated = false;

  const canRecover = (error: unknown): boolean => {
    if (activated || abortSignal.aborted) return false;
    const details = extractErrorDetails(error);
    return (
      (details.statusCode === 413 &&
        details.providerErrorCode === "media_dimensions_too_large") ||
      (details.statusCode === 415 &&
        details.providerErrorCode === "media_type_unsupported")
    );
  };

  return (model: LanguageModel): LanguageModel => {
    if (
      typeof model === "string" ||
      model.specificationVersion !== "v3" ||
      !isAbliterationModel(model.modelId)
    )
      return model;

    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        wrapStream: async ({ params }) => {
          abortSignal.throwIfAborted();
          params.abortSignal?.throwIfAborted();
          const prompt = activated
            ? await preprocess(params.prompt, { force: true })
            : params.prompt;
          try {
            return await model.doStream({ ...params, prompt });
          } catch (error) {
            // Only an HTTP rejection before a stream exists is replayable.
            // Never replay text/tool output or handle moderation as media error.
            if (params.abortSignal?.aborted || !canRecover(error)) throw error;
            activated = true;
            const recovered = await preprocess(prompt, { force: true });
            if (recovered === prompt) throw error;
            abortSignal.throwIfAborted();
            params.abortSignal?.throwIfAborted();
            return model.doStream({ ...params, prompt: recovered });
          }
        },
      },
    });
  };
}
