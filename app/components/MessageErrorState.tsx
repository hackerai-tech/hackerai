import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ChatSDKError } from "@/lib/errors";

interface MessageErrorStateProps {
  error: Error;
  onRegenerate: () => void;
}

export const MessageErrorState = ({
  error,
  onRegenerate,
}: MessageErrorStateProps) => {
  const isRateLimitError =
    error instanceof ChatSDKError && error.type === "rate_limit";

  return (
    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
      <div className="text-destructive text-sm mb-2">
        {isRateLimitError ? (
          <MemoizedMarkdown
            content={
              typeof error.cause === "string" ? error.cause : error.message
            }
          />
        ) : (
          <p>An error occurred.</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" onClick={onRegenerate}>
          {isRateLimitError ? "Try Again" : "Retry"}
        </Button>
        {isRateLimitError && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              window.open("https://github.com/hackerai-tech/hackerai", "_blank")
            }
          >
            Self Host
          </Button>
        )}
      </div>
    </div>
  );
};
