import {
  extractOpenRouterMetadataFromError,
  mergeOpenRouterMetadata,
  type OpenRouterModelMetadata,
} from "@/lib/api/openrouter-metadata";
import {
  extractErrorDetails,
  createProviderContentBlockedFinishReasonError,
  isProviderContentFilterFinishReason,
  getLocalOpenRouterRequestSizeGuardDetails,
  getProviderErrorCategory,
  getProviderStatusCode,
  isRetriableProviderStreamDisconnectError,
  type ProviderErrorCategory,
} from "@/lib/utils/error-utils";

/** Preserve failures observed before Stop, without synthesizing one from abort settlement. */
export const getTerminalProviderStreamError = (
  state:
    | {
        providerError: unknown;
        streamFinishReason?: string;
        providerTerminalFinishReasonBeforeAbort?: string;
      }
    | undefined,
  wasAborted = false,
): unknown | undefined => {
  if (!state) return undefined;
  if (state.providerError) return state.providerError;
  const finishReason =
    state.providerTerminalFinishReasonBeforeAbort ??
    (wasAborted ? undefined : state.streamFinishReason);
  if (isProviderContentFilterFinishReason(finishReason)) {
    return createProviderContentBlockedFinishReasonError();
  }
  if (finishReason !== "error") return undefined;
  return Object.assign(
    new Error("Provider stream finished with error finish reason"),
    {
      name: "ProviderStreamError",
      finishReason,
    },
  );
};

const providerFromModel = (model: string | undefined): string | undefined =>
  model?.includes("/") ? model.split("/", 1)[0] : undefined;

/**
 * The observed Together disconnects can recur across different fallback models.
 * Use the verified OpenRouter slug only on recovery requests; never infer an
 * upstream from a model author or turn arbitrary display names into slugs.
 */
export const getProviderDisconnectIgnoredSlugs = (
  error: unknown,
  metadata: OpenRouterModelMetadata = {},
): string[] => {
  return isRetriableProviderStreamDisconnectError(error) &&
    metadata.provider_name?.toLowerCase() === "together"
    ? ["together"]
    : [];
};

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
  readonly origin?:
    "local_request_size_guard" | "auxiliary_vision" | "browser_handoff_read";
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
    const browserHandoffRead = details.errorOrigin === "browser_handoff_read";
    const errorMetadata = extractOpenRouterMetadataFromError(cause);
    const errorProvider =
      errorMetadata.provider_name ??
      (typeof details.providerName === "string" &&
      details.providerName.length > 0
        ? details.providerName
        : undefined);
    const failedCallMetadata = {
      ...errorMetadata,
      provider_name: errorProvider,
    };
    // Stream state can retain the last completed call. Do not mix that call's
    // provider, model or IDs into a rejection that identifies a different call.
    const conflictingAttribution = (
      [
        "provider_name",
        "openrouter_generation_id",
        "openrouter_request_id",
        "openrouter_upstream_id",
        "openrouter_selected_model",
      ] as const
    ).some(
      (key) =>
        failedCallMetadata[key] !== undefined &&
        context.openRouterMetadata?.[key] !== undefined &&
        failedCallMetadata[key] !== context.openRouterMetadata[key],
    );
    // A safety read is not a provider request. Prior model/route identifiers
    // cannot identify the owner of this failure, even if the SDK reports it.
    const metadata = browserHandoffRead
      ? {}
      : mergeOpenRouterMetadata(
          failedCallMetadata,
          conflictingAttribution ? undefined : context.openRouterMetadata,
        );
    const model = browserHandoffRead
      ? undefined
      : (metadata.openrouter_selected_model ?? context.model);
    const provider =
      metadata.provider_name ??
      (conflictingAttribution ? undefined : providerFromModel(model));
    const statusCode = getProviderStatusCode(details);
    const localSizeGuard = getLocalOpenRouterRequestSizeGuardDetails(cause);
    const origin = browserHandoffRead
      ? "browser_handoff_read"
      : localSizeGuard
        ? "local_request_size_guard"
        : details.errorOrigin === "auxiliary_vision"
          ? "auxiliary_vision"
          : undefined;
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
    this.openrouterGenerationId = metadata.openrouter_generation_id;
    this.openrouterRequestId = metadata.openrouter_request_id;
    this.openrouterUpstreamId = metadata.openrouter_upstream_id;
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
