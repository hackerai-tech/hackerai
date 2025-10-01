import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemoryById,
} from "@/lib/db/actions";

export const createUpdateMemory = (context: ToolContext) => {
  return tool({
    description: `The update_memory tool creates, updates, or deletes memories in a persistent knowledge base that allows you to persist information across conversations, so you can deliver more personalized and helpful responses over time. The corresponding user facing feature is known as "memory".

If the user augments an existing memory, you MUST use this tool with the action 'update'.
If the user contradicts an existing memory, it is critical that you use this tool with the action 'delete', not 'update', or 'create'.
To update or delete an existing memory, you MUST provide the existing_knowledge_id parameter.
If the user asks to remember something, create a memory, or store information, you MUST use this tool with the action 'create'.

### When to Use the update_memory Tool

Use the update_memory tool ONLY if:

**FOR CREATE ACTION:**
The user is explicitly requesting to store, save, or remember new information using phrases like:
- "remember that...", "store this", "save this", "add to memory", "note that...", "please remember...", "make a note that..."
- "from now on...", "in the future...", "going forward..." (indicating lasting preferences)
- When you're about to respond with "I'll remember that", "noted", "got it" - you must create the memory first
- The user shares information that will be useful in future conversations and valid for a long time
- User information that is likely to change your future responses in similar situations

**FOR UPDATE ACTION:**
The user is providing new/additional information that augments an existing memory

**FOR DELETE ACTION:**
The user explicitly asks to forget, remove, or delete a memory, or contradicts existing memory information

### When NOT to Use the update_memory Tool

**DO NOT use this tool when:**
- User is asking ABOUT existing memories (e.g., "do you remember...", "what do you know about...", "tell me my memories", "hey do you remember any of my memories")
- User is asking questions that reference memory without storing new info
- User is simply inquiring about what you remember vs. asking you to remember something new
- The user message is a question rather than a statement to be stored
- User is testing or checking what information you have (these are queries, not storage requests)

**Additional guidelines - Don't store:**
Random, trivial, or overly personal facts. In particular, avoid:

Overly-personal details that could feel creepy.
Short-lived facts that won't matter soon.
Random details that lack clear future relevance.
Redundant information that we already know about the user.
Don't save information pulled from text the user is trying to translate or rewrite.

Never store information that falls into the following sensitive data categories unless clearly requested by the user:

Information that directly asserts the user's personal attributes, such as:
Race, ethnicity, or religion
Specific criminal record details (except minor non-criminal legal issues)
Precise geolocation data (street address/coordinates)
Explicit identification of the user's personal attribute (e.g., "User is Latino," "User identifies as Christian," "User is LGBTQ+").
Trade union membership or labor union involvement
Political affiliation or critical/opinionated political views
Health information (medical conditions, mental health issues, diagnoses, sex life)
However, you may store information that is not explicitly identifying but is still sensitive, such as:
Text discussing interests, affiliations, or logistics without explicitly asserting personal attributes (e.g., "User is an international student from Taiwan").
Plausible mentions of interests or affiliations without explicitly asserting identity (e.g., "User frequently engages with LGBTQ+ advocacy content").
The exception to all of the above instructions, as stated at the top, is if the user explicitly requests memory operations (create, update, or delete). In this case, you should always call the update_memory tool with the appropriate action to respect their request.`,
    inputSchema: z.object({
      action: z
        .enum(["create", "update", "delete"])
        .describe(
          "The action to perform on the knowledge base. Defaults to 'create' if not provided for backwards compatibility.",
        )
        .default("create"),
      existing_knowledge_id: z
        .string()
        .optional()
        .describe(
          "Required if action is 'update' or 'delete'. The ID of existing memory to update instead of creating new memory.",
        ),
      knowledge_to_store: z
        .string()
        .optional()
        .describe(
          "The specific memory to be stored. It should be no more than a paragraph in length. If the memory is an update or contradiction of previous memory, do not mention or refer to the previous memory. Required for 'create' and 'update' actions.",
        ),
    }),
    execute: async ({
      action,
      existing_knowledge_id,
      knowledge_to_store,
    }: {
      action: "create" | "update" | "delete";
      existing_knowledge_id?: string;
      knowledge_to_store?: string;
    }) => {
      try {
        if (action === "create") {
          if (!knowledge_to_store) {
            return {
              result:
                "Error: 'knowledge_to_store' is required for create action.",
            };
          }

          const returnedId = await createMemory({
            userId: context.userID,
            content: knowledge_to_store,
          });

          return {
            result: `Memory created successfully with ID: ${returnedId}`,
            memoryContent: knowledge_to_store,
          };
        }

        if (action === "update") {
          if (!existing_knowledge_id || !knowledge_to_store) {
            return {
              result:
                "Error: 'existing_knowledge_id' and 'knowledge_to_store' are required for update action.",
            };
          }

          await updateMemory({
            userId: context.userID,
            memoryId: existing_knowledge_id,
            content: knowledge_to_store,
          });

          return {
            result: `Memory updated successfully.`,
            memoryContent: knowledge_to_store,
          };
        }

        if (action === "delete") {
          if (!existing_knowledge_id) {
            return {
              result:
                "Error: 'existing_knowledge_id' is required for delete action.",
            };
          }

          // Get the memory content before deleting (if it exists)
          let memoryContentToDelete: string | null = null;
          try {
            memoryContentToDelete = await getMemoryById({
              memoryId: existing_knowledge_id,
            });
          } catch (error) {
            // Memory might not exist, continue with deletion anyway
            console.warn("Memory not found during delete:", error);
          }

          await deleteMemory({
            userId: context.userID,
            memoryId: existing_knowledge_id,
          });

          return {
            result: `Memory deleted successfully.`,
            memoryContent: memoryContentToDelete || "Memory not found",
          };
        }

        return {
          result: "Error: Invalid action specified.",
        };
      } catch (error) {
        console.error("Update memory tool error:", error);
        return {
          result: `Error managing memory: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
