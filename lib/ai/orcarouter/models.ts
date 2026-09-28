/**
 * Client-safe OrcaRouter model helpers. Catalog models are selected as
 * `orcarouter:<vendor/model>` so the persisted selection names the provider
 * explicitly and keeps the catalog's vendor/model namespace verbatim.
 */
export const ORCAROUTER_MODEL_PREFIX = "orcarouter:";

export type OrcaRouterModelKey = `${typeof ORCAROUTER_MODEL_PREFIX}${string}`;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*(\/[A-Za-z0-9._:-]+)+$/;
const MODEL_ID_MAX_LENGTH = 200;

export const isValidOrcaRouterModelId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MODEL_ID_MAX_LENGTH &&
  MODEL_ID_PATTERN.test(value);

export const toOrcaRouterModelKey = (modelId: string): OrcaRouterModelKey =>
  `${ORCAROUTER_MODEL_PREFIX}${modelId}`;

export const isOrcaRouterModelKey = (
  value: unknown,
): value is OrcaRouterModelKey =>
  typeof value === "string" &&
  value.startsWith(ORCAROUTER_MODEL_PREFIX) &&
  isValidOrcaRouterModelId(value.slice(ORCAROUTER_MODEL_PREFIX.length));

export const getOrcaRouterModelId = (key: OrcaRouterModelKey): string =>
  key.slice(ORCAROUTER_MODEL_PREFIX.length);

export type OrcaRouterModel = {
  id: string;
  inputModalities: string[];
};

export type OrcaRouterCatalogCapability = "chat" | "image-chat";

/**
 * Image turns require an explicit `image` input modality. Models that do not
 * declare their modalities fail closed and are hidden from image turns.
 */
export const supportsImageInput = (model: OrcaRouterModel) =>
  model.inputModalities.includes("image");

export function filterOrcaRouterModels(
  models: readonly OrcaRouterModel[],
  capability: OrcaRouterCatalogCapability,
): OrcaRouterModel[] {
  return capability === "image-chat"
    ? models.filter(supportsImageInput)
    : [...models];
}

/** Query parameter the Connect callback uses to report its result. */
export const ORCAROUTER_CONNECT_RESULT_PARAM = "orcarouter_connect";
