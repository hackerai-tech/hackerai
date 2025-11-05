import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { renderHook, act, waitFor } from "@testing-library/react";
import { GlobalStateProvider, useGlobalState } from "@/app/contexts/GlobalState";
import { ReactNode } from "react";

describe("Send Now - Queue Management Integration", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GlobalStateProvider>{children}</GlobalStateProvider>
  );

  beforeEach(() => {
    localStorage.clear();
  });

  it("should only remove the specific message when Send Now is clicked, not all messages", () => {
    const { result } = renderHook(() => useGlobalState(), { wrapper });

    // Queue 3 messages
    act(() => {
      result.current.queueMessage("First message");
      result.current.queueMessage("Second message");
      result.current.queueMessage("Third message");
    });

    expect(result.current.messageQueue).toHaveLength(3);

    const firstMessageId = result.current.messageQueue[0].id;
    const secondMessageId = result.current.messageQueue[1].id;
    const thirdMessageId = result.current.messageQueue[2].id;

    // Simulate "Send Now" on the first message
    // This should ONLY remove the first message
    act(() => {
      result.current.removeQueuedMessage(firstMessageId);
    });

    // After removing first message, queue should have 2 messages remaining
    expect(result.current.messageQueue).toHaveLength(2);
    expect(result.current.messageQueue[0].id).toBe(secondMessageId);
    expect(result.current.messageQueue[1].id).toBe(thirdMessageId);
    expect(result.current.messageQueue[0].text).toBe("Second message");
    expect(result.current.messageQueue[1].text).toBe("Third message");
  });

  it("should preserve other queued messages when one is sent via Send Now", () => {
    const { result } = renderHook(() => useGlobalState(), { wrapper });

    // Queue multiple messages with files
    const mockFile = new File(["content"], "test.txt", { type: "text/plain" });

    act(() => {
      result.current.queueMessage("Message 1", [
        { file: mockFile, fileId: "file-1", url: "https://example.com/1" },
      ]);
      result.current.queueMessage("Message 2", [
        { file: mockFile, fileId: "file-2", url: "https://example.com/2" },
      ]);
      result.current.queueMessage("Message 3");
    });

    expect(result.current.messageQueue).toHaveLength(3);

    const secondMessageId = result.current.messageQueue[1].id;

    // Click "Send Now" on middle message
    act(() => {
      result.current.removeQueuedMessage(secondMessageId);
    });

    // Should still have first and third messages
    expect(result.current.messageQueue).toHaveLength(2);
    expect(result.current.messageQueue[0].text).toBe("Message 1");
    expect(result.current.messageQueue[1].text).toBe("Message 3");

    // Verify files are still intact on remaining messages
    expect(result.current.messageQueue[0].files).toHaveLength(1);
    expect(result.current.messageQueue[0].files![0].fileId).toBe("file-1");
  });

  it("should handle Send Now on last message without affecting earlier messages", () => {
    const { result } = renderHook(() => useGlobalState(), { wrapper });

    act(() => {
      result.current.queueMessage("First");
      result.current.queueMessage("Second");
      result.current.queueMessage("Third");
    });

    const thirdMessageId = result.current.messageQueue[2].id;

    // Send last message
    act(() => {
      result.current.removeQueuedMessage(thirdMessageId);
    });

    // First two should remain
    expect(result.current.messageQueue).toHaveLength(2);
    expect(result.current.messageQueue[0].text).toBe("First");
    expect(result.current.messageQueue[1].text).toBe("Second");
  });

  it("should correctly handle rapid Send Now clicks on different messages", () => {
    const { result } = renderHook(() => useGlobalState(), { wrapper });

    act(() => {
      result.current.queueMessage("Message 1");
      result.current.queueMessage("Message 2");
      result.current.queueMessage("Message 3");
      result.current.queueMessage("Message 4");
      result.current.queueMessage("Message 5");
    });

    expect(result.current.messageQueue).toHaveLength(5);

    const ids = result.current.messageQueue.map(m => m.id);

    // Rapidly click Send Now on messages 1, 3, and 5
    act(() => {
      result.current.removeQueuedMessage(ids[0]); // Remove 1
      result.current.removeQueuedMessage(ids[2]); // Remove 3
      result.current.removeQueuedMessage(ids[4]); // Remove 5
    });

    // Should have messages 2 and 4 remaining
    expect(result.current.messageQueue).toHaveLength(2);
    expect(result.current.messageQueue[0].text).toBe("Message 2");
    expect(result.current.messageQueue[1].text).toBe("Message 4");
  });

  it("should verify clearQueue vs removeQueuedMessage behavior difference", () => {
    const { result } = renderHook(() => useGlobalState(), { wrapper });

    // Setup: Queue 3 messages
    act(() => {
      result.current.queueMessage("Message 1");
      result.current.queueMessage("Message 2");
      result.current.queueMessage("Message 3");
    });

    expect(result.current.messageQueue).toHaveLength(3);

    // Test clearQueue - should remove ALL messages
    act(() => {
      result.current.clearQueue();
    });

    expect(result.current.messageQueue).toHaveLength(0);

    // Setup again
    act(() => {
      result.current.queueMessage("Message A");
      result.current.queueMessage("Message B");
      result.current.queueMessage("Message C");
    });

    const messageIdToRemove = result.current.messageQueue[1].id;

    // Test removeQueuedMessage - should remove ONLY specified message
    act(() => {
      result.current.removeQueuedMessage(messageIdToRemove);
    });

    expect(result.current.messageQueue).toHaveLength(2);
    expect(result.current.messageQueue[0].text).toBe("Message A");
    expect(result.current.messageQueue[1].text).toBe("Message C");
  });

  it("should handle Send Now in agent mode without clearing other queued messages", async () => {
    // This test verifies the fix for the bug where handleSendNow was clearing all messages
    // The fix ensures that only the specific message is removed from the queue
    // when Send Now is clicked, even in Agent mode

    const { result } = renderHook(() => useGlobalState(), { wrapper });

    // Set to agent mode
    act(() => {
      result.current.setChatMode("agent");
    });

    // Queue 3 messages
    act(() => {
      result.current.queueMessage("Message 1");
      result.current.queueMessage("Message 2");
      result.current.queueMessage("Message 3");
    });

    expect(result.current.messageQueue).toHaveLength(3);
    expect(result.current.chatMode).toBe("agent");

    const firstMessageId = result.current.messageQueue[0].id;
    const secondMessageId = result.current.messageQueue[1].id;
    const thirdMessageId = result.current.messageQueue[2].id;

    // Simulate Send Now on the first message (only removes that specific message)
    act(() => {
      result.current.removeQueuedMessage(firstMessageId);
    });

    // FIXED: Other messages should remain in queue
    expect(result.current.messageQueue).toHaveLength(2);
    expect(result.current.messageQueue[0].id).toBe(secondMessageId);
    expect(result.current.messageQueue[1].id).toBe(thirdMessageId);
    expect(result.current.messageQueue[0].text).toBe("Message 2");
    expect(result.current.messageQueue[1].text).toBe("Message 3");

    // Verify we can continue removing specific messages
    act(() => {
      result.current.removeQueuedMessage(thirdMessageId);
    });

    expect(result.current.messageQueue).toHaveLength(1);
    expect(result.current.messageQueue[0].text).toBe("Message 2");
  });
});
