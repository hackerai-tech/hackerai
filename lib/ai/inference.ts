import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const INFERENCE_CYBER_MODEL_KEY = "model-inference-cyber";
export const INFERENCE_CYBER_MODEL_ID = "deepseek-v4.1-flash-1017-cyber";
export { INFERENCE_CYBER_FLAG } from "../experiments/abliteration-keys";
// Native capacity validated through the normal Agent attachment allowance.
// Count the entire prompt, including tool screenshots, against this budget.
export const INFERENCE_MAX_IMAGES_PER_REQUEST = 20;

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
