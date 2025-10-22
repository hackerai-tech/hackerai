import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "../contexts/GlobalState";
import {
  countInputTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { toast } from "sonner";

interface MessageEditorProps {
  initialContent: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}

export const MessageEditor = ({
  initialContent,
  onSave,
  onCancel,
}: MessageEditorProps) => {
  const { subscription } = useGlobalState();
  const [content, setContent] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  useEffect(() => {
    // Auto-focus and select all text when component mounts
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, []);

  const handleSave = () => {
    const trimmedContent = content.trim();
    if (!trimmedContent) return;

    // Check token limit for edited content based on user plan
    const tokenCount = countInputTokens(trimmedContent, []);
    const maxTokens = getMaxTokensForSubscription(subscription);

    if (tokenCount > maxTokens) {
      const planText = subscription !== "free" ? "" : " (Free plan limit)";
      toast.error("Message is too long", {
        description: `Your edited message is too large (${tokenCount.toLocaleString()} tokens). Maximum is ${maxTokens.toLocaleString()} tokens${planText}.`,
      });
      return;
    }

    onSave(trimmedContent);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="w-full bg-secondary border border-border rounded-lg p-4 space-y-3">
      <TextareaAutosize
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full p-3 text-foreground rounded-md resize-none focus:outline-none"
        minRows={2}
        maxRows={10}
      />
      <div className="flex justify-end space-x-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!content.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
};
