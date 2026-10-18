import type { ModelMessage } from "ai";

/** Replay private handoff context once per retained model history. */
export function appendBrowserHandoffNotes(
  messages: ModelMessage[],
  notes: Array<{ text: string }>,
): ModelMessage[] {
  const existing = new Set(
    messages.flatMap((message) =>
      message.role === "user" && typeof message.content === "string"
        ? [message.content]
        : [],
    ),
  );
  const result = [...messages];
  for (const note of notes) {
    if (existing.has(note.text)) continue;
    result.push({ role: "user", content: note.text });
    existing.add(note.text);
  }
  return result;
}
