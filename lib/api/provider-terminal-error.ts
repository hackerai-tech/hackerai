import type { OpenRouterModelMetadata } from "@/lib/api/openrouter-metadata";
import {
  extractErrorDetails,
  getLocalOpenRouterRequestSizeGuardDetails,
  getProviderErrorCategory,
  getProviderStatusCode,
  type ProviderErrorCategory,
} from "@/lib/utils/error-utils";

const providerFromModel = (model: string | undefined): string | undefined =>
  model?.includes("/") ? model.split("/", 1)[0] : undefined;

/**
 * Low-cardinality provider failure envelope used by Trigger.dev error
 * fingerprinting. Provider and model remain structured fields for diagnosis,
 * but do not create a separate unresolved error group for every upstream.
 */
export class ProviderTerminalError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly category: ProviderErrorCategory;
  readonly statusCode?: number;
  readonly origin?: "local_request_size_guard";
  readonly localRequestId?: string;
  readonly requestBytesBefore?: number;
  readonly requestBytesAfter?: number;
  readonly requestLimitBytes?: number;
  readonly openrouterGenerationId?: string;
  readonly openrouterRequestId?: string;
  readonly openrouterUpstreamId?: string;

  constructor(
    cause: unknown,
    context: {
      model?: string;
      openRouterMetadata?: OpenRouterModelMetadata;
    },
  ) {
    const details = extractErrorDetails(cause);
    const category = getProviderErrorCategory(details);
    const model =
      context.openRouterMetadata?.openrouter_selected_model ?? context.model;
    const provider =
      context.openRouterMetadata?.provider_name ??
      (typeof details.providerName === "string"
        ? details.providerName
        : providerFromModel(model));
    const statusCode = getProviderStatusCode(details);
    const localSizeGuard = getLocalOpenRouterRequestSizeGuardDetails(cause);
    const origin = localSizeGuard ? "local_request_size_guard" : undefined;
    const message = [
      "Provider terminal error",
      `category=${category}`,
      origin ? `origin=${origin}` : undefined,
      statusCode ? `status=${statusCode}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    super(message, { cause });
    this.name = "ProviderTerminalError";
    this.provider = provider ?? "unknown";
    this.model = model ?? "unknown";
    this.category = category;
    this.statusCode = statusCode;
    this.origin = origin;
    this.localRequestId = localSizeGuard?.requestId;
    this.requestBytesBefore = localSizeGuard?.requestBytesBefore;
    this.requestBytesAfter = localSizeGuard?.requestBytesAfter;
    this.requestLimitBytes = localSizeGuard?.limitBytes;
    this.openrouterGenerationId =
      context.openRouterMetadata?.openrouter_generation_id;
    this.openrouterRequestId =
      context.openRouterMetadata?.openrouter_request_id;
    this.openrouterUpstreamId =
      context.openRouterMetadata?.openrouter_upstream_id;
  }
}

/** Preserve the original cause while adding stable provider failure fields. */
export const wrapProviderTerminalError = (
  error: unknown,
  context: {
    model?: string;
    openRouterMetadata?: OpenRouterModelMetadata;
  },
): ProviderTerminalError =>
  error instanceof ProviderTerminalError
    ? error
    : new ProviderTerminalError(error, context);
