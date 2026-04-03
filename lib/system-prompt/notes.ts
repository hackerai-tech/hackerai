interface Note {
  readonly note_id: string;
  readonly title: string;
  readonly content: string;
  readonly category: string;
  readonly tags: string[];
  readonly updated_at: number;
}

/**
 * Static message for the system prompt when notes are disabled.
 * This is stable across the session and safe for prompt caching.
 */
export const getNotesDisabledMessage = (
  isFreeUser: boolean = false,
): string => `<notes>
The notes tool is disabled. Do not use it.
${
  isFreeUser
    ? "If the user explicitly asks you to save a note, let them know that notes are available on paid plans and suggest upgrading."
    : "If the user explicitly asks you to save a note, politely ask them to go to **Settings > Personalization > Notes** to enable notes."
}
</notes>`;

/**
 * Generate the notes section for injection via system-reminder in messages.
 * Only "general" category notes are passed here (filtered by getNotesForBackend).
 * Other categories must be retrieved via the list_notes tool.
 */
export const generateNotesSection = (notes: Note[] | null): string => {
  if (!notes || notes.length === 0) {
    return "";
  }

  const notesContent = notes
    .map((note) => {
      const date = new Date(note.updated_at).toISOString().split("T")[0];
      const tagsStr = note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : "";
      return `- [${date}] **${note.title}**${tagsStr}: ${note.content} (ID: ${note.note_id})`;
    })
    .join("\n");

  return `<notes>
These are the user's general notes for context. Use them to provide more personalized assistance.

<user_notes>
${notesContent}
</user_notes>
</notes>`;
};

export type { Note };
