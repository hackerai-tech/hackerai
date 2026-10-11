import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const ABLITERATION_MODEL_KEY = "model-abliterated";
export const ABLITERATION_MODEL_ID = "abliterated-model";
export const ABLITERATION_LARGE_V2_MODEL_KEY = "model-abliterated-large-v2";
export const ABLITERATION_LARGE_V2_MODEL_ID = "abliterated-model-large-v2";

export const isAbliterationModel = (modelName: string | undefined) =>
  modelName === ABLITERATION_MODEL_KEY ||
  modelName === ABLITERATION_MODEL_ID ||
  modelName === ABLITERATION_LARGE_V2_MODEL_KEY ||
  modelName === ABLITERATION_LARGE_V2_MODEL_ID;

// Server-only credential. Missing credentials never make a request eligible.
export const isAbliterationConfigured = () =>
  Boolean(process.env.ABLITERATION_API_KEY?.trim());

export const abliteration = createOpenAICompatible({
  name: "abliteration",
  baseURL: "https://api.abliteration.ai/v1",
  apiKey: process.env.ABLITERATION_API_KEY,
  includeUsage: true,
});

// USD per million tokens; https://docs.abliteration.ai/pricing (2026-10-01).
export const ABLITERATION_BASE_PRICING = {
  input: 1,
  output: 3,
  cacheRead: 0.1,
  cacheWrite: 1,
};

// Historical Large v2 accounting; the Max trial uses only the base model above.
// Current provider rates verified at the pricing URL above (2026-10-10).
export const ABLITERATION_LARGE_V2_PRICING = {
  input: 3,
  output: 5,
  cacheRead: 0.3,
  cacheWrite: 3,
};
