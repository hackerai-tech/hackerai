import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ChatSDKError } from "@/lib/errors";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";

interface MessageErrorStateProps {
  error: Error;
  onRetry: () => void;
}

export const MessageErrorState = ({
  error,
  onRetry,
}: MessageErrorStateProps) => {
  const { subscription } = useGlobalState();
  const isRateLimitError =
    error instanceof ChatSDKError && error.type === "rate_limit";

  // Extract error message - check for cause first, then message
  const errorMessage = (() => {
    if (error instanceof ChatSDKError) {
      return typeof error.cause === "string" ? error.cause : error.message;
    }
    return error.message || "An error occurred.";
  })();

  return (
    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
      <div className="text-destructive text-sm mb-2">
        {isRateLimitError ? (
          <MemoizedMarkdown content={errorMessage} />
        ) : (
          <p>{errorMessage}</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" onClick={onRetry}>
          {isRateLimitError ? "Try Again" : "Retry"}
        </Button>
        {isRateLimitError && subscription === "free" && (
          <Button variant="default" size="sm" onClick={redirectToPricing}>
            Upgrade
          </Button>
        )}
      </div>
    </div>
  );
};
