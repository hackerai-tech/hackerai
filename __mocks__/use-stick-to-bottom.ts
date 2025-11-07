// Simple mock for use-stick-to-bottom
export const useStickToBottom = () => ({
  scrollRef: { current: null },
  contentRef: { current: null },
  isAtBottom: true,
  scrollToBottom: jest.fn(),
});

export default useStickToBottom;
