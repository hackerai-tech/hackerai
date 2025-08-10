interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const ChatInput = ({
  input,
  setInput,
  onSubmit,
  onStop,
  status,
}: ChatInputProps) => {
  const isGenerating = status === "submitted" || status === "streaming";

  return (
    <div className="border-t border-border p-4 bg-card">
      <form onSubmit={onSubmit}>
        <div className="flex space-x-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={status !== "ready"}
            placeholder="Ask me anything..."
            className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50"
            autoFocus
          />
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              className="px-4 py-2 bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-label="Stop generation"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={status !== "ready" || !input.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
};