import type { OpenRouterModelMetadata } from "@/lib/api/openrouter-metadata";
import {
  extractErrorDetails,
  getProviderErrorCategory,
  getProviderStatusCode,
  isLocalOpenRouterRequestSizeGuardError,
  type ProviderErrorCategory,
} from "@/lib/utils/error-utils";

const fingerprintToken = (value: string | undefined): string =>
  (value ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";

const providerFromModel = (model: string | undefined): string | undefined =>
  model?.includes("/") ? model.split("/", 1)[0] : undefined;

/** Stable provider failure envelope used by Trigger.dev error fingerprinting. */
export class ProviderTerminalError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly category: ProviderErrorCategory;
  readonly statusCode?: number;
  readonly origin?: "local_request_size_guard";
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
    const origin = isLocalOpenRouterRequestSizeGuardError(cause)
      ? "local_request_size_guard"
      : undefined;
    const message = [
      "Provider terminal error",
      `provider=${fingerprintToken(provider)}`,
      `model=${fingerprintToken(model)}`,
      `category=${fingerprintToken(category)}`,
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
