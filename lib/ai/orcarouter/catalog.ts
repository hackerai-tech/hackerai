/**
 * OrcaRouter model discovery. The live `GET /v1/models` response is the
 * authoritative catalog; when it is unavailable the selector falls back to a
 * small verified seed and says so. Responses are bounded in time, bytes and
 * item count, and records the chat route cannot speak are dropped.
 */
import {
  filterOrcaRouterModels,
  isValidOrcaRouterModelId,
  type OrcaRouterCatalogCapability,
  type OrcaRouterModel,
} from "@/lib/ai/orcarouter/models";

export type OrcaRouterCatalog =
  | { status: "live"; models: OrcaRouterModel[] }
  | {
      status: "fallback";
      reason: "network" | "malformed";
      models: OrcaRouterModel[];
    }
  | { status: "unauthorized"; models: [] };

export const ORCAROUTER_CATALOG_TIMEOUT_MS = 10_000;
export const ORCAROUTER_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
export const ORCAROUTER_CATALOG_MAX_ITEMS = 1_000;

const CHAT_ENDPOINT_TYPES = new Set([
  "openai",
  "openai-response",
  "anthropic",
  "gemini",
]);
const NON_TEXT_ENDPOINT_TYPES = new Set([
  "image-generation",
  "openai-video",
  "jina-rerank",
  "embeddings",
]);

/**
 * Verified cold-start seed, used only when live discovery fails. Modalities
 * are kept so image turns still offer only image-capable models offline.
 */
export const ORCAROUTER_FALLBACK_MODELS: readonly OrcaRouterModel[] = [
  { id: "openai/gpt-5.5", inputModalities: ["text", "image"] },
  { id: "anthropic/claude-opus-4.8", inputModalities: ["text", "image"] },
  { id: "google/gemini-3.5-flash", inputModalities: ["text", "image"] },
  { id: "deepseek/deepseek-v4-pro", inputModalities: ["text"] },
  { id: "orcarouter/auto", inputModalities: ["text"] },
];

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

type RawModel = {
  id: string;
  endpointTypes: string[];
  inputModalities: string[];
};

const parseRawModel = (value: unknown): RawModel | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isValidOrcaRouterModelId(record.id)) return null;
  const architecture =
    record.architecture && typeof record.architecture === "object"
      ? (record.architecture as Record<string, unknown>)
      : {};
  return {
    id: record.id,
    endpointTypes: stringArray(record.supported_endpoint_types),
    inputModalities: stringArray(architecture.input_modalities),
  };
};

const isChatModel = (model: RawModel) =>
  model.endpointTypes.some((type) => CHAT_ENDPOINT_TYPES.has(type)) &&
  !model.endpointTypes.some((type) => NON_TEXT_ENDPOINT_TYPES.has(type));

export function parseOrcaRouterCatalog(body: unknown): OrcaRouterModel[] {
  const data =
    body && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) throw new Error("catalog data is not an array");

  const seen = new Set<string>();
  const models: OrcaRouterModel[] = [];
  for (const item of data.slice(0, ORCAROUTER_CATALOG_MAX_ITEMS)) {
    const model = parseRawModel(item);
    if (!model || !isChatModel(model) || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, inputModalities: model.inputModalities });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

const readBoundedText = async (response: Response, maxBytes: number) => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("catalog response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("catalog response is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const fallback = (
  reason: "network" | "malformed",
  capability: OrcaRouterCatalogCapability,
): OrcaRouterCatalog => ({
  status: "fallback",
  reason,
  models: filterOrcaRouterModels(ORCAROUTER_FALLBACK_MODELS, capability),
});

export async function fetchOrcaRouterCatalog({
  apiBaseUrl,
  apiKey,
  capability,
  fetchImpl = fetch,
  timeoutMs = ORCAROUTER_CATALOG_TIMEOUT_MS,
}: {
  apiBaseUrl: string;
  apiKey: string;
  capability: OrcaRouterCatalogCapability;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OrcaRouterCatalog> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/models?capability=chat`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    return fallback("network", capability);
  }

  if (response.status === 401) return { status: "unauthorized", models: [] };
  if (!response.ok) return fallback("network", capability);

  try {
    const text = await readBoundedText(response, ORCAROUTER_CATALOG_MAX_BYTES);
    const models = parseOrcaRouterCatalog(JSON.parse(text));
    return {
      status: "live",
      models: filterOrcaRouterModels(models, capability),
    };
  } catch {
    return fallback("malformed", capability);
  }
}
