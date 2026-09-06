import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const ABLITERATION_MODEL_KEY = "model-abliterated";
export const ABLITERATION_MODEL_ID = "abliterated-model";

export const isAbliterationModel = (modelName: string) =>
  modelName === ABLITERATION_MODEL_KEY || modelName === ABLITERATION_MODEL_ID;

// Server-only credential. Missing credentials never make a request eligible.
export const isAbliterationConfigured = () =>
  Boolean(process.env.ABLITERATION_API_KEY?.trim());

export const abliteration = createOpenAICompatible({
  name: "abliteration",
  baseURL: "https://api.abliteration.ai/v1",
  apiKey: process.env.ABLITERATION_API_KEY,
  includeUsage: true,
});

// USD per million tokens; https://docs.abliteration.ai/pricing (2026-09-06).
export const ABLITERATION_PRICING = {
  input: 3,
  output: 3,
  cacheRead: 0.3,
  cacheWrite: 3,
};
