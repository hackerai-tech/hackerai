import { describe, it, expect } from "@jest/globals";
import { cn, convertToUIMessages } from "../utils";
import type { MessageRecord } from "../utils";
import type { Id } from "@/convex/_generated/dataModel";

describe("utils", () => {
  describe("cn", () => {
    it("should merge class names correctly", () => {
      const result = cn("px-4", "py-2", "bg-blue-500");
      expect(result).toBe("px-4 py-2 bg-blue-500");
    });

    it("should handle conditional classes", () => {
      const isActive = true;
      const result = cn("base-class", isActive && "active-class");
      expect(result).toBe("base-class active-class");
    });

    it("should handle tailwind conflicts", () => {
      const result = cn("px-4", "px-8");
      expect(result).toBe("px-8");
    });
  });

  describe("convertToUIMessages", () => {
    it("should convert MessageRecord array to ChatMessage array", () => {
      const messages: MessageRecord[] = [
        {
          id: "msg1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          id: "msg2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }],
          source_message_id: "msg1",
          feedback: { feedbackType: "positive" },
        },
      ];

      const result = convertToUIMessages(messages);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("msg1");
      expect(result[0].role).toBe("user");
      expect(result[0].parts[0]).toEqual({ type: "text", text: "Hello" });
      expect(result[1].sourceMessageId).toBe("msg1");
      expect(result[1].metadata?.feedbackType).toBe("positive");
    });

    it("should handle messages without feedback", () => {
      const messages: MessageRecord[] = [
        {
          id: "msg1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
      ];

      const result = convertToUIMessages(messages);

      expect(result[0].metadata).toBeUndefined();
    });

    it("should handle messages with file details", () => {
      const messages: MessageRecord[] = [
        {
          id: "msg1",
          role: "user",
          parts: [{ type: "text", text: "Check this file" }],
          fileDetails: [
            {
              fileId: "file1" as Id<"files">,
              name: "document.pdf",
              url: "https://example.com/document.pdf",
            },
          ],
        },
      ];

      const result = convertToUIMessages(messages);

      expect(result[0].fileDetails).toHaveLength(1);
      expect(result[0].fileDetails?.[0].name).toBe("document.pdf");
    });
  });
});
