"use node";

import { logger } from "@trigger.dev/sdk/v3";
import type { UIMessageStreamWriter } from "ai";
import { metadataStream, type MetadataEvent } from "../streams";

/** Append a metadata event as a JSON string so the client receives parseable data. */
export function appendMetadata(event: MetadataEvent): Promise<void> {
  return metadataStream.append(JSON.stringify(event));
}

/** Creates a writer-like object that appends data-* parts to metadataStream */
export function createMetadataWriter(): UIMessageStreamWriter {
  return {
    write(part: { type: string; data?: unknown }) {
      if (!part.type.startsWith("data-")) return;
      // UIMessageStreamWriter types `part.type` as `string`; the `data-` prefix check
      // above guarantees only our known metadata event types reach here.
      const event = { type: part.type, data: part.data } as MetadataEvent;
      appendMetadata(event).catch((err) =>
        logger.warn("Failed to append metadata event", {
          type: part.type,
          err,
        }),
      );
    },
    merge: () => {
      // No-op: we pipe LLM stream separately to aiStream
    },
    onError: undefined,
  };
}
