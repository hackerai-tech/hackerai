interface Memory {
  readonly memory_id: string;
  readonly content: string;
  readonly update_time: number;
}

// Memory section generation with combined logic
export const generateMemorySection = (
  memories: Memory[] | null,
  shouldIncludeMemories: boolean = true,
): string => {
  const baseMemoryInstructions = `<memories>
Use these memories to provide more personalized and helpful responses when relevant.`;

  const disabledMemoryMessage = `<memories>
The \`update_memory\` tool is disabled. Do not send any messages to it.
If the user explicitly asks you to remember something, politely ask them to go to **Settings > Personalization > Memory** to enable memory.
</memories>`;

  if (!shouldIncludeMemories) {
    return disabledMemoryMessage;
  }

  if (!memories || memories.length === 0) {
    return "";
  }

  // Show all memories without sorting
  const memoryContent = memories
    .map((memory) => {
      const date = new Date(memory.update_time).toISOString().split("T")[0];
      return `- [${date}] ${memory.content} (ID: ${memory.memory_id})`;
    })
    .join("\n");

  return `${baseMemoryInstructions}

<user_memories>
${memoryContent}
</user_memories>
</memories>`;
};

export type { Memory };
