export type OpenRouterAttemptMetadata = {
  provider?: string;
  model?: string;
  status?: number;
  selected?: boolean;
};

export type OpenRouterModelMetadata = {
  provider_gateway: "openrouter";
  provider_name?: string;
  openrouter_generation_id?: string;
  openrouter_request_id?: string;
  openrouter_is_byok?: boolean;
  openrouter_router?: string;
  openrouter_strategy?: string;
  openrouter_region?: string;
  openrouter_attempt?: number;
  openrouter_upstream_id?: string;
  openrouter_selected_model?: string;
  openrouter_attempts?: OpenRouterAttemptMetadata[];
};

type ResponseLike = {
  id?: unknown;
  headers?: unknown;
};

const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";
const GENERATION_FETCH_TIMEOUT_MS = 1500;
const MAX_ATTEMPTS_TO_LOG = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const pickNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pickBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

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
      const item: OpenRouterAttemptMetadata = {
        provider: pickString(attempt.provider),
        model: pickString(attempt.model),
        status: pickNumber(attempt.status),
        selected: pickBoolean(attempt.selected),
      };
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
    openrouter_selected_model:
      pickString(selectedEndpoint?.model) ??
      pickString(successfulAttempt?.model),
    openrouter_attempts: attempts,
  };
};

const metadataFromGenerationPayload = (
  data: Record<string, unknown>,
): Partial<OpenRouterModelMetadata> => ({
  provider_name: pickString(data.provider_name),
  openrouter_request_id: pickString(data.request_id),
  openrouter_is_byok: pickBoolean(data.is_byok),
  openrouter_router: pickString(data.router),
  openrouter_upstream_id: pickString(data.upstream_id),
});

export function extractOpenRouterMetadata(args: {
  response?: ResponseLike;
  providerMetadata?: unknown;
}): OpenRouterModelMetadata {
  const routerMetadata = findOpenRouterMetadata(args.providerMetadata);
  return compactOpenRouterMetadata({
    provider_gateway: "openrouter",
    openrouter_generation_id: pickGenerationId(args.response),
    openrouter_request_id: pickRequestId(args.response, routerMetadata),
    ...metadataFromRouterPayload(routerMetadata),
  });
}

export function mergeOpenRouterMetadata(
  primary: OpenRouterModelMetadata,
  secondary: OpenRouterModelMetadata | undefined,
): OpenRouterModelMetadata {
  if (!secondary) return primary;

  const { provider_gateway: _primaryGateway, ...primaryFields } = primary;
  const { provider_gateway: _secondaryGateway, ...secondaryFields } = secondary;

  return compactOpenRouterMetadata({
    provider_gateway: "openrouter",
    ...secondaryFields,
    ...primaryFields,
    provider_name: primary.provider_name ?? secondary.provider_name,
    openrouter_request_id:
      primary.openrouter_request_id ?? secondary.openrouter_request_id,
    openrouter_is_byok:
      primary.openrouter_is_byok ?? secondary.openrouter_is_byok,
    openrouter_router: primary.openrouter_router ?? secondary.openrouter_router,
    openrouter_upstream_id:
      primary.openrouter_upstream_id ?? secondary.openrouter_upstream_id,
  });
}

function compactOpenRouterMetadata(
  metadata: OpenRouterModelMetadata,
): OpenRouterModelMetadata {
  const compact: OpenRouterModelMetadata = {
    provider_gateway: "openrouter",
  };

  for (const [key, value] of Object.entries(metadata)) {
    if (key === "provider_gateway") continue;
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (compact as Record<string, unknown>)[key] = value;
  }

  return compact;
}

export async function fetchOpenRouterGenerationMetadata(
  generationId: string | undefined,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<OpenRouterModelMetadata | undefined> {
  if (!generationId) return undefined;

  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? GENERATION_FETCH_TIMEOUT_MS,
  );

  try {
    const url = new URL(OPENROUTER_GENERATION_URL);
    url.searchParams.set("id", generationId);

    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !isRecord(payload.data)) return undefined;

    return compactOpenRouterMetadata({
      provider_gateway: "openrouter",
      openrouter_generation_id: generationId,
      ...metadataFromGenerationPayload(payload.data),
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
