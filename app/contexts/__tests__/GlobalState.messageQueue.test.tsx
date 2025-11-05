import { renderHook, act } from '@testing-library/react';
import { GlobalStateProvider, useGlobalState } from '../GlobalState';
import { ReactNode } from 'react';

describe('GlobalState - Message Queue', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GlobalStateProvider>{children}</GlobalStateProvider>
  );

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  describe('queueMessage', () => {
    it('should add a message to the queue', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Test message');
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0]).toMatchObject({
        text: 'Test message',
        files: undefined,
      });
      expect(result.current.messageQueue[0].id).toBeDefined();
      expect(result.current.messageQueue[0].timestamp).toBeDefined();
    });

    it('should add a message with files to the queue', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      const mockFile = new File(['content'], 'test.txt', { type: 'text/plain' });
      const files = [
        {
          file: mockFile,
          fileId: 'file-123',
          url: 'https://example.com/file.txt',
        },
      ];

      act(() => {
        result.current.queueMessage('Test message with file', files);
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.messageQueue[0]).toMatchObject({
        text: 'Test message with file',
        files,
      });
    });

    it('should queue multiple messages', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Message 1');
        result.current.queueMessage('Message 2');
        result.current.queueMessage('Message 3');
      });

      expect(result.current.messageQueue).toHaveLength(3);
      expect(result.current.messageQueue[0].text).toBe('Message 1');
      expect(result.current.messageQueue[1].text).toBe('Message 2');
      expect(result.current.messageQueue[2].text).toBe('Message 3');
    });

    it('should not queue more than 10 messages', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        // Queue 11 messages
        for (let i = 1; i <= 11; i++) {
          result.current.queueMessage(`Message ${i}`);
        }
      });

      // Should only have 10 messages
      expect(result.current.messageQueue).toHaveLength(10);
    });
  });

  describe('removeQueuedMessage', () => {
    it('should remove a specific message from the queue', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Message 1');
        result.current.queueMessage('Message 2');
        result.current.queueMessage('Message 3');
      });

      expect(result.current.messageQueue).toHaveLength(3);

      const messageId = result.current.messageQueue[1].id;

      act(() => {
        result.current.removeQueuedMessage(messageId);
      });

      expect(result.current.messageQueue).toHaveLength(2);
      expect(result.current.messageQueue[0].text).toBe('Message 1');
      expect(result.current.messageQueue[1].text).toBe('Message 3');
    });

    it('should do nothing if message ID does not exist', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Message 1');
      });

      const originalLength = result.current.messageQueue.length;

      act(() => {
        result.current.removeQueuedMessage('non-existent-id');
      });

      expect(result.current.messageQueue).toHaveLength(originalLength);
    });
  });

  describe('clearQueue', () => {
    it('should clear all messages from the queue', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Message 1');
        result.current.queueMessage('Message 2');
        result.current.queueMessage('Message 3');
      });

      expect(result.current.messageQueue).toHaveLength(3);

      act(() => {
        result.current.clearQueue();
      });

      expect(result.current.messageQueue).toHaveLength(0);
    });

    it('should handle clearing an already empty queue', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      expect(result.current.messageQueue).toHaveLength(0);

      act(() => {
        result.current.clearQueue();
      });

      expect(result.current.messageQueue).toHaveLength(0);
    });
  });

  describe('dequeueNext', () => {
    it('should remove and return the first message from the queue', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Message 1');
        result.current.queueMessage('Message 2');
        result.current.queueMessage('Message 3');
      });

      let dequeuedMessage: any;

      act(() => {
        dequeuedMessage = result.current.dequeueNext();
      });

      expect(dequeuedMessage.text).toBe('Message 1');
      expect(result.current.messageQueue).toHaveLength(2);
      expect(result.current.messageQueue[0].text).toBe('Message 2');
      expect(result.current.messageQueue[1].text).toBe('Message 3');
    });

    it('should return null when queue is empty', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      let dequeuedMessage: any;

      act(() => {
        dequeuedMessage = result.current.dequeueNext();
      });

      expect(dequeuedMessage).toBeNull();
      expect(result.current.messageQueue).toHaveLength(0);
    });

    it('should dequeue all messages in order', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.queueMessage('Message 1');
        result.current.queueMessage('Message 2');
        result.current.queueMessage('Message 3');
      });

      let message1: any, message2: any, message3: any;

      act(() => {
        message1 = result.current.dequeueNext();
      });

      act(() => {
        message2 = result.current.dequeueNext();
      });

      act(() => {
        message3 = result.current.dequeueNext();
      });

      expect(message1.text).toBe('Message 1');
      expect(message2.text).toBe('Message 2');
      expect(message3.text).toBe('Message 3');
      expect(result.current.messageQueue).toHaveLength(0);
    });
  });

  describe('Chat mode interaction', () => {
    it('should maintain queue when in agent mode', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.setChatMode('agent');
        result.current.queueMessage('Agent message');
      });

      expect(result.current.messageQueue).toHaveLength(1);
      expect(result.current.chatMode).toBe('agent');
    });

    it('should allow queueing in ask mode (clearing happens at component level)', () => {
      const { result } = renderHook(() => useGlobalState(), { wrapper });

      act(() => {
        result.current.setChatMode('ask');
        result.current.queueMessage('Ask message');
      });

      // GlobalState doesn't enforce mode restrictions - that's at component level
      expect(result.current.messageQueue).toHaveLength(1);
    });
  });
});
