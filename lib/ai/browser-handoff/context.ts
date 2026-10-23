import type { ModelMessage } from "ai";

/** Keep private updates at their original position across SDK step replays.
 * prepareStep messages are not retained by the SDK. If compaction removes an
 * anchor, restore its note before retained history, not as a new user turn.
 */
export function createBrowserHandoffNoteProjector() {
  const anchors = new Map<string, string | null>();
  return (
    messages: ModelMessage[],
    notes: Array<{ id: string; text: string }>,
  ): ModelMessage[] => {
    const result = [...messages];
    let previousNoteEnd = 0;
    for (const note of notes) {
      const retained = result.findIndex(
        (message) => message.role === "user" && message.content === note.text,
      );
      if (retained !== -1) {
        if (!anchors.has(note.id))
          anchors.set(
            note.id,
            retained ? JSON.stringify(result[retained - 1]) : null,
          );
        previousNoteEnd = retained + 1;
        continue;
      }
      let index = result.length;
      if (anchors.has(note.id)) {
        const anchor = anchors.get(note.id);
        const position =
          anchor == null
            ? -1
            : result.findLastIndex(
                (message) => JSON.stringify(message) === anchor,
              );
        index = position + 1;
        // System messages must remain ahead of restored user context.
        while (result[index]?.role === "system") index++;
      } else {
        anchors.set(
          note.id,
          result.length ? JSON.stringify(result.at(-1)) : null,
        );
      }
      index = Math.max(index, previousNoteEnd);
      previousNoteEnd = index + 1;
      result.splice(index, 0, { role: "user", content: note.text });
    }
    return result;
  };
}
