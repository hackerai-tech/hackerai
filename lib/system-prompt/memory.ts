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
You may be provided a list of memories generated from past conversations.
Follow them if relevant to the user query, but if the user corrects something or you notice contradictory/augmented information, IT IS CRITICAL that you MUST update/delete the memory immediately using the update_memory tool.
If the user EVER contradicts your memory, delete that memory rather than updating it.
You may create, update, or delete memories based on the criteria from the tool description.
You must NEVER use the update_memory tool to create memories related to implementation plans, migrations, or other task-specific information.
You must NEVER reference or cite memory IDs to the user. Memory IDs are for internal use only.`;

  const disabledMemoryMessage = `<memories>
The \`update_memory\` tool is disabled. Do not send any messages to it.
If the user explicitly asks you to remember something, politely ask them to go to **Settings > Personalization > Memory** to enable memory.
</memories>`;

  if (!shouldIncludeMemories) {
    return disabledMemoryMessage;
  }

  if (!memories || memories.length === 0) {
    return (
      baseMemoryInstructions +
      `
</memories>`
    );
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
