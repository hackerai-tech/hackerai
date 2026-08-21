export type OpenRouterAttemptMetadata = {
  provider?: string;
  model?: string;
  status?: number;
  selected?: boolean;
};

export type OpenRouterModelMetadata = {
  provider_name?: string;
  openrouter_generation_id?: string;
  openrouter_request_id?: string;
  openrouter_is_byok?: boolean;
  openrouter_router?: string;
  openrouter_strategy?: string;
  openrouter_region?: string;
  openrouter_attempt?: number;
  openrouter_upstream_id?: string;
  openrouter_upstream_inference_cost?: number;
  openrouter_selected_model?: string;
  openrouter_attempts?: OpenRouterAttemptMetadata[];
};

type ResponseLike = {
  id?: unknown;
  headers?: unknown;
};

const MAX_ATTEMPTS_TO_LOG = 8;
const MAX_ERROR_SOURCE_DEPTH = 4;
const OPENROUTER_GENERATION_LOOKUP_TIMEOUT_MS = 2_500;
const OPENROUTER_GENERATION_LOOKUP_RETRY_DELAY_MS = 150;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const pickIdentifier = (value: unknown): string | undefined => {
  const identifier = pickString(value);
  return identifier && identifier.length <= 512 ? identifier : undefined;
};

const pickNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pickPositiveNumber = (value: unknown): number | undefined => {
  const number = pickNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
};

const pickBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const pickUpstreamInferenceCost = (
  metadata: Record<string, unknown>,
): number | undefined =>
  pickPositiveNumber(metadata.upstream_inference_cost) ??
  pickPositiveNumber(metadata.upstreamInferenceCost);

const normalizeHeaders = (headers: unknown): Record<string, string> => {
  if (!headers) return {};

  if (headers instanceof Headers) {
    return Object.fromEntries(
      Array.from(headers.entries()).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
  }

  if (!isRecord(headers)) return {};

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
};

const getHeader = (headers: unknown, name: string): string | undefined => {
  const normalized = normalizeHeaders(headers);
  return pickString(normalized[name.toLowerCase()]);
};

const pickGenerationId = (
  response: ResponseLike | undefined,
): string | undefined => {
  const headerId = getHeader(response?.headers, "x-generation-id");
  if (headerId?.startsWith("gen-")) return headerId;

  const responseId = pickString(response?.id);
  if (responseId?.startsWith("gen-")) return responseId;

  return undefined;
};

const pickRequestId = (
  response: ResponseLike | undefined,
  metadata?: Record<string, unknown>,
): string | undefined =>
  pickString(metadata?.request_id) ??
  getHeader(response?.headers, "request-id") ??
  getHeader(response?.headers, "x-request-id");

const findOpenRouterMetadata = (source: unknown): Record<string, unknown> => {
  if (!isRecord(source)) return {};

  const direct = source.openrouter_metadata;
  if (isRecord(direct)) return direct;

  const openrouter = source.openrouter;
  if (!isRecord(openrouter)) return {};

  const nested = openrouter.openrouter_metadata;
  if (isRecord(nested)) return nested;

  // Some provider adapters expose the metadata object directly under the
  // provider key. Treat it as router metadata only when it has router fields.
  if (
    typeof openrouter.provider === "string" ||
    typeof openrouter.requested === "string" ||
    typeof openrouter.strategy === "string" ||
    pickUpstreamInferenceCost(openrouter) !== undefined ||
    isRecord(openrouter.endpoints) ||
    Array.isArray(openrouter.attempts)
  ) {
    return openrouter;
  }

  return {};
};

const pickAttempts = (
  metadata: Record<string, unknown>,
): OpenRouterAttemptMetadata[] | undefined => {
  const attempts = metadata.attempts;
  if (!Array.isArray(attempts)) return undefined;

  const sanitized = attempts
    .slice(0, MAX_ATTEMPTS_TO_LOG)
    .map((attempt): OpenRouterAttemptMetadata | undefined => {
      if (!isRecord(attempt)) return undefined;
      const item: OpenRouterAttemptMetadata = {};
      const provider = pickString(attempt.provider);
      const model = pickString(attempt.model);
      const status = pickNumber(attempt.status);
      const selected = pickBoolean(attempt.selected);
      if (provider) item.provider = provider;
      if (model) item.model = model;
      if (status !== undefined) item.status = status;
      if (selected !== undefined) item.selected = selected;
      return Object.values(item).some((value) => value !== undefined)
        ? item
        : undefined;
    })
    .filter((attempt): attempt is OpenRouterAttemptMetadata =>
      Boolean(attempt),
    );

  return sanitized.length > 0 ? sanitized : undefined;
};

const pickSelectedEndpoint = (
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const endpoints = metadata.endpoints;
  if (!isRecord(endpoints) || !Array.isArray(endpoints.available)) {
    return undefined;
  }

  return endpoints.available.find(
    (endpoint): endpoint is Record<string, unknown> =>
      isRecord(endpoint) && endpoint.selected === true,
  );
};

const pickSuccessfulAttempt = (
  attempts: OpenRouterAttemptMetadata[] | undefined,
): OpenRouterAttemptMetadata | undefined =>
  attempts?.find((attempt) => attempt.status === 200) ?? attempts?.at(-1);

const metadataFromRouterPayload = (
  metadata: Record<string, unknown>,
): Partial<OpenRouterModelMetadata> => {
  const attempts = pickAttempts(metadata);
  const selectedEndpoint = pickSelectedEndpoint(metadata);
  const successfulAttempt = pickSuccessfulAttempt(attempts);

  return {
    provider_name:
      pickString(metadata.provider) ??
      pickString(selectedEndpoint?.provider) ??
      pickString(successfulAttempt?.provider),
    openrouter_is_byok: pickBoolean(metadata.is_byok),
    openrouter_strategy: pickString(metadata.strategy),
    openrouter_region: pickString(metadata.region),
    openrouter_attempt: pickNumber(metadata.attempt),
    openrouter_request_id: pickIdentifier(metadata.request_id),
    openrouter_router: pickString(metadata.router),
    openrouter_upstream_id: pickIdentifier(metadata.upstream_id),
    openrouter_upstream_inference_cost: pickUpstreamInferenceCost(metadata),
    openrouter_selected_model:
      pickString(selectedEndpoint?.model) ??
      pickString(successfulAttempt?.model),
    openrouter_attempts: attempts,
  };
};

const parseJsonRecord = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const collectErrorRecords = (
  value: unknown,
  records: Record<string, unknown>[] = [],
  seen = new WeakSet<object>(),
  depth = 0,
): Record<string, unknown>[] => {
  if (!isRecord(value) || seen.has(value) || depth > MAX_ERROR_SOURCE_DEPTH) {
    return records;
  }
  seen.add(value);
  records.push(value);

  for (const key of ["error", "cause"] as const) {
    collectErrorRecords(value[key], records, seen, depth + 1);
  }
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors.slice(0, MAX_ATTEMPTS_TO_LOG)) {
      collectErrorRecords(nested, records, seen, depth + 1);
    }
  }
  return records;
};

const metadataFromGenerationPayload = (
  source: unknown,
  options: { includeSelectedModel?: boolean } = {},
): OpenRouterModelMetadata => {
  const payload =
    isRecord(source) && isRecord(source.data) ? source.data : source;
  if (!isRecord(payload)) return {};

  return compactOpenRouterMetadata({
    provider_name: pickString(payload.provider_name),
    openrouter_generation_id: pickGenerationId({ id: payload.id }),
    openrouter_request_id: pickIdentifier(payload.request_id),
    openrouter_router: pickString(payload.router),
    openrouter_upstream_id: pickIdentifier(payload.upstream_id),
    openrouter_upstream_inference_cost: pickPositiveNumber(
      payload.upstream_inference_cost,
    ),
    openrouter_selected_model: options.includeSelectedModel
      ? pickString(payload.model)
      : undefined,
  });
};

/** Extract IDs and provider attribution retained on a failed OpenRouter call. */
export function extractOpenRouterMetadataFromError(
  error: unknown,
): OpenRouterModelMetadata {
  let metadata: OpenRouterModelMetadata = {};

  for (const source of collectErrorRecords(error)) {
    const response = isRecord(source.response) ? source.response : undefined;
    const responseHeaders = source.responseHeaders ?? response?.headers;
    const data = parseJsonRecord(source.data);
    const responseBody = parseJsonRecord(source.responseBody);

    // Parsed payload metadata is more specific than wrapper response headers,
    // so visit it first and let primary-first merging retain those IDs.
    for (const payload of [data, responseBody, source]) {
      if (!payload) continue;
      const routerMetadata = findOpenRouterMetadata(payload);
      const nestedError = isRecord(payload.error) ? payload.error : undefined;
      const errorMetadata = isRecord(nestedError?.metadata)
        ? nestedError.metadata
        : undefined;
      const generationMetadata = metadataFromGenerationPayload(payload);
      const routerPayloadMetadata = metadataFromRouterPayload(routerMetadata);
      metadata = mergeOpenRouterMetadata(metadata, {
        ...generationMetadata,
        ...routerPayloadMetadata,
        openrouter_generation_id:
          generationMetadata.openrouter_generation_id ??
          pickGenerationId({ id: payload.id, headers: responseHeaders }),
        openrouter_request_id:
          generationMetadata.openrouter_request_id ??
          pickRequestId({ headers: responseHeaders }, routerMetadata),
        provider_name:
          pickString(errorMetadata?.provider_name) ??
          routerPayloadMetadata.provider_name,
      });
    }

    metadata = mergeOpenRouterMetadata(metadata, {
      openrouter_generation_id: pickGenerationId({
        id: source.id,
        headers: responseHeaders,
      }),
      openrouter_request_id: pickRequestId({ headers: responseHeaders }),
    });
  }

  return compactOpenRouterMetadata(metadata);
}

/** Best-effort lookup for IDs OpenRouter only exposes on its generation record. */
export async function fetchOpenRouterGenerationMetadata(
  generationId: string,
  options: {
    apiKey?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {},
): Promise<OpenRouterModelMetadata> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey || !generationId.startsWith("gen-")) {
    return {};
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? OPENROUTER_GENERATION_LOOKUP_TIMEOUT_MS,
  );
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await (options.fetch ?? globalThis.fetch)(
          `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          },
        );
        if (response.ok) {
          const payload = (await response.json()) as unknown;
          return mergeOpenRouterMetadata(
            metadataFromGenerationPayload(payload, {
              includeSelectedModel: true,
            }),
            { openrouter_generation_id: generationId },
          );
        }
        if (response.status === 404 && attempt === 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, OPENROUTER_GENERATION_LOOKUP_RETRY_DELAY_MS),
          );
          continue;
        }
        console.warn("[openrouter-metadata] generation lookup failed", {
          event: "openrouter_generation_lookup_failed",
          generationId,
          statusCode: response.status,
          attempt,
        });
        return {};
      } catch (error) {
        console.warn("[openrouter-metadata] generation lookup failed", {
          event: "openrouter_generation_lookup_failed",
          generationId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          attempt,
        });
        return {};
      }
    }
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

export function extractOpenRouterMetadata(args: {
  response?: ResponseLike;
  providerMetadata?: unknown;
}): OpenRouterModelMetadata {
  const routerMetadata = findOpenRouterMetadata(args.providerMetadata);
  return compactOpenRouterMetadata({
    ...metadataFromRouterPayload(routerMetadata),
    openrouter_generation_id: pickGenerationId(args.response),
    openrouter_request_id: pickRequestId(args.response, routerMetadata),
  });
}

export function mergeOpenRouterMetadata(
  primary: OpenRouterModelMetadata,
  secondary: OpenRouterModelMetadata | undefined,
): OpenRouterModelMetadata {
  if (!secondary) return primary;

  return compactOpenRouterMetadata({
    ...secondary,
    ...primary,
    provider_name: primary.provider_name ?? secondary.provider_name,
    openrouter_request_id:
      primary.openrouter_request_id ?? secondary.openrouter_request_id,
    openrouter_is_byok:
      primary.openrouter_is_byok ?? secondary.openrouter_is_byok,
    openrouter_router: primary.openrouter_router ?? secondary.openrouter_router,
    openrouter_upstream_id:
      primary.openrouter_upstream_id ?? secondary.openrouter_upstream_id,
    openrouter_upstream_inference_cost:
      primary.openrouter_upstream_inference_cost ??
      secondary.openrouter_upstream_inference_cost,
  });
}

function compactOpenRouterMetadata(
  metadata: OpenRouterModelMetadata,
): OpenRouterModelMetadata {
  const compact: OpenRouterModelMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (compact as Record<string, unknown>)[key] = value;
  }

  return compact;
}
