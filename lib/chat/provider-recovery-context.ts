import type { ModelMessage } from "ai";
import { sourceMessageDigests } from "./model-history";

/** Request-local only. The canonical UI transcript remains the source of truth. */
export type ProviderRecoveryContext = {
  source: string[];
  messages: ModelMessage[];
};

/** Reuse a summary only while its covered source is still an exact prefix. */
export function restoreProviderRecoveryContext(
  checkpoint: ProviderRecoveryContext | undefined,
  source: ModelMessage[],
): ModelMessage[] | undefined {
  if (!checkpoint?.source.length) return;
  let matched = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    for (const digest of sourceMessageDigests([source[cursor]])) {
      if (digest !== checkpoint.source[matched++]) return;
    }
    if (matched === checkpoint.source.length) {
      return [...checkpoint.messages, ...source.slice(cursor + 1)];
    }
  }
}
