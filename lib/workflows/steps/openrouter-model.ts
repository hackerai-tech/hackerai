import fs from "node:fs";
import { myProvider } from "@/lib/ai/providers";

const LOG_FILE = "/tmp/hackerai-workflow.log";
function log(msg: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

/**
 * Module-level factory mirroring the @workflow/ai `anthropic()`/`openai()`
 * helper pattern: returns an inner async arrow marked with "use step" so the
 * SWC plugin can register it as a step. The LanguageModel never crosses the
 * step boundary; only the modelId string travels via closure capture.
 */
export function openrouterModel(modelId: string) {
  return async () => {
    "use step";
    log(
      `openrouter.model.resolve modelId=${modelId} hasOpenRouterKey=${!!process.env.OPENROUTER_API_KEY}`,
    );
    try {
      const model = myProvider.languageModel(modelId);
      log(
        `openrouter.model.resolved provider=${(model as { provider?: string }).provider ?? "?"} modelId=${(model as { modelId?: string }).modelId ?? "?"}`,
      );
      return model;
    } catch (err) {
      log(
        `openrouter.model.resolve.error ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  };
}
