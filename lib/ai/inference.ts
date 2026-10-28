import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const INFERENCE_CYBER_MODEL_KEY = "model-inference-cyber";
export const INFERENCE_CYBER_MODEL_ID = "deepseek-v4.1-flash-1017-cyber";
export const INFERENCE_CYBER_PREVIEW_FLAG = "inference_cyber_preview_v1";

export const isInferenceCyberModel = (model?: string) =>
  model === INFERENCE_CYBER_MODEL_KEY || model === INFERENCE_CYBER_MODEL_ID;

export const isInferenceConfigured = () =>
  Boolean(process.env.INFERENCE_API_KEY?.trim());

export const inference = createOpenAICompatible({
  name: "inference",
  baseURL: "https://api.inference.net/v1",
  apiKey: process.env.INFERENCE_API_KEY,
  includeUsage: true,
});

// USD per million tokens, verified against the provider catalog 2026-10-27.
export const INFERENCE_CYBER_PRICING = {
  input: 0.3,
  cacheRead: 0.007,
  cacheWrite: 0.3,
  output: 1,
};
