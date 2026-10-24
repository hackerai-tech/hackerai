import type { ModelMessage } from "ai";

/** Keep private updates at their original position across SDK step replays.
 * prepareStep messages are not retained by the SDK. If compaction removes an
 * anchor, restore its note after the new summary and before retained history.
 */
export function createBrowserHandoffNoteProjector() {
  const anchors = new Map<string, string | null>();
  const projectedIds = new WeakMap<ModelMessage, string>();
  return (
    messages: ModelMessage[],
    notes: Array<{ id: string; text: string }>,
    compactedPrefixLength?: number,
  ): ModelMessage[] => {
    const result = [...messages];
    let previousNoteEnd = 0;
    for (const note of notes) {
      const retained = result.findIndex(
        (message) => projectedIds.get(message) === note.id,
      );
      if (retained !== -1) {
        previousNoteEnd = retained + 1;
        continue;
      }
      let index = Math.max(
        compactedPrefixLength ?? result.length,
        previousNoteEnd,
      );
      if (anchors.has(note.id)) {
        const anchor = anchors.get(note.id);
        const position =
          anchor == null
            ? -1
            : previousNoteEnd > 0 &&
                JSON.stringify(result[previousNoteEnd - 1]) === anchor
              ? previousNoteEnd - 1
              : result.findLastIndex(
                  (message) => JSON.stringify(message) === anchor,
                );
        index = position + 1;
        if (position === -1 && compactedPrefixLength !== undefined) {
          index = Math.max(compactedPrefixLength, previousNoteEnd);
          anchors.set(
            note.id,
            index ? JSON.stringify(result[index - 1]) : null,
          );
        }
        // System messages must remain ahead of restored user context.
        while (result[index]?.role === "system") index++;
        index = Math.max(index, previousNoteEnd);
        // Cloned provider messages lose object identity. Only reuse matching
        // text at this note's recorded position, never arbitrary user history.
        const existing = result[index];
        if (existing?.role === "user" && existing.content === note.text) {
          projectedIds.set(existing, note.id);
          previousNoteEnd = index + 1;
          continue;
        }
      } else {
        anchors.set(note.id, index ? JSON.stringify(result[index - 1]) : null);
      }
      index = Math.max(index, previousNoteEnd);
      previousNoteEnd = index + 1;
      const message: ModelMessage = { role: "user", content: note.text };
      projectedIds.set(message, note.id);
      result.splice(index, 0, message);
    }
    return result;
  };
}
