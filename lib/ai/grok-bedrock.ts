/**
 * Grok 4.6 served by Amazon Bedrock through OpenRouter. It recovers requests
 * that xAI's own endpoint refuses or fails, before switching model families.
 *
 * OpenRouter exposes this pairing only on its US regional endpoint; the
 * global endpoint reports no allowed provider for the Bedrock pin.
 */
export const GROK_4_6_BEDROCK_MODEL_KEY = "model-grok-4.6-bedrock";
export const OPENROUTER_US_BASE_URL = "https://us.openrouter.ai/api/v1";
export const AMAZON_BEDROCK_ONLY_ROUTING: {
  only: string[];
  allow_fallbacks: false;
} = { only: ["amazon-bedrock"], allow_fallbacks: false };
