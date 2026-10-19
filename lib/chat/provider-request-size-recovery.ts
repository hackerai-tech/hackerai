import { wrapLanguageModel, type LanguageModel } from "ai";
import {
  classifyProviderOverflowError,
  extractErrorDetails,
  getProviderStatusCode,
  isLocalOpenRouterRequestSizeGuardError,
} from "@/lib/utils/error-utils";

/** Only pre-stream rejections are replayable; never replay a partially consumed stream. */
export function withProviderRequestSizeRecovery(
  model: LanguageModel,
  options: {
    state: { attempted: boolean };
    abortSignal: AbortSignal;
    compact: () => Promise<string | undefined>;
    commit: (summary: string) => void;
  },
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3")
    return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ params }) => {
        try {
          return await model.doStream(params);
        } catch (error) {
          if (
            options.state.attempted ||
            options.abortSignal.aborted ||
            params.abortSignal?.aborted
          )
            throw error;
          const details = extractErrorDetails(error);
          const status = getProviderStatusCode(details);
          const overflow = classifyProviderOverflowError(error);
          const mediaCode =
            typeof details.providerErrorCode === "string" &&
            /^(?:media|image|file)[_-]/i.test(details.providerErrorCode);
          if (
            !isLocalOpenRouterRequestSizeGuardError(error) &&
            !(
              !mediaCode &&
              overflow !== "media" &&
              (status === 413 || (status === 400 && overflow === "context"))
            )
          )
            throw error;
          // Shared across all model wrappers and SDK/provider retries in this run.
          options.state.attempted = true;
          const summary = await options.compact();
          options.abortSignal.throwIfAborted();
          params.abortSignal?.throwIfAborted();
          if (!summary) throw error;
          const prompt: typeof params.prompt = [
            ...params.prompt.filter((message) => message.role === "system"),
            { role: "user", content: [{ type: "text", text: summary }] },
          ];
          const bytes = (value: unknown) =>
            new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (bytes(prompt) >= bytes(params.prompt)) throw error;
          options.commit(summary);
          // Same model, system, tools, tool choice and provider options. A second
          // rejection (including a lower upstream limit) propagates normally.
          return model.doStream({ ...params, prompt });
        }
      },
    },
  });
}
