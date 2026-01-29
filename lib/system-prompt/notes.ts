interface Note {
  readonly note_id: string;
  readonly title: string;
  readonly content: string;
  readonly category: string;
  readonly tags: string[];
  readonly updated_at: number;
}

/**
 * Generate the notes section for the system prompt
 * Only "general" category notes are passed here (filtered by getNotesForBackend)
 * Other categories must be retrieved via the list_notes tool
 */
export const generateNotesSection = (
  notes: Note[] | null,
  shouldIncludeNotes: boolean = true,
): string => {
  const disabledNotesMessage = `<notes>
The notes tool is disabled. Do not use it.
If the user explicitly asks you to save a note, politely ask them to go to **Settings > Personalization > Notes** to enable notes.
</notes>`;

  if (!shouldIncludeNotes) {
    return disabledNotesMessage;
  }

  if (!notes || notes.length === 0) {
    return "";
  }

  // Format notes for the system prompt
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
