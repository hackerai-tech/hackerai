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
Unless the user explicitly requests memory operations, DO NOT call this tool with the action 'create'.

### When to Use the update_memory Tool

Use the update_memory tool if:

The user is requesting memory operations (create, update, or delete).
Such requests could use a variety of phrases including, but not limited to: "remember that...", "store this", "add to memory", "note that...", "forget that...", "delete this", "update my memory about...", "change what you know about...", etc.
Anytime the user message includes one of these phrases or similar, reason about whether they are requesting memory operations.
Anytime you determine that the user is requesting memory operations, you should always call the update_memory tool with the appropriate action (create/update/delete), even if the requested information has already been stored, appears extremely trivial or fleeting, etc.
Anytime you are unsure whether the user is requesting memory operations, you must ask the user for clarification in a follow-up message.
Anytime you are going to write a message to the user that includes a phrase such as "noted", "got it", "I'll remember that", or similar, you should make sure to call the update_memory tool first with action 'create', before sending this message to the user.
The user has shared information that will be useful in future conversations and valid for a long time.
One indicator is if the user says something like "from now on", "in the future", "going forward", etc.
Anytime the user shares information that will likely be true for months or years, reason about whether it is worth creating a memory entry.
User information is worth creating a memory for if it is likely to change your future responses in similar situations.

### When NOT to Use the update_memory Tool

Don't store random, trivial, or overly personal facts. In particular, avoid:

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

          // Get the memory content before deleting
          const memoryContentToDelete = await getMemoryById({
            memoryId: existing_knowledge_id,
          });

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
