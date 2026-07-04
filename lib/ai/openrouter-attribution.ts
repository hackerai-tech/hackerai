export const OPENROUTER_APP_REFERER = "https://zhacker.ai";
export const OPENROUTER_APP_TITLE = "ZHACKER";
export const OPENROUTER_APP_CATEGORIES = "cloud-agent,cli-agent";

export const openrouterAttributionHeaders = {
  "HTTP-Referer": OPENROUTER_APP_REFERER,
  "X-OpenRouter-Title": OPENROUTER_APP_TITLE,
  "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES,
} as const;
