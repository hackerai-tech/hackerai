"use client";

import { UIMessage } from "@ai-sdk/react";
import type { ChatStatus } from "@/types";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";

type ReasoningHandlerProps = {
  message: UIMessage;
  partIndex: number;
  status: ChatStatus;
  isLastMessage?: boolean;
};

const collectReasoningText = (
  parts: UIMessage["parts"],
  startIndex: number,
): string => {
  const collected: string[] = [];
  for (let i = startIndex; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type === "reasoning") {
      collected.push(part.text ?? "");
    } else {
      break;
    }
  }
  return collected.join("");
};

export const ReasoningHandler = ({
  message,
  partIndex,
  status,
  isLastMessage,
}: ReasoningHandlerProps) => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const currentPart = parts[partIndex];

  if (currentPart?.type !== "reasoning") return null;

  // Skip if previous part is also reasoning (avoid duplicate renders)
  const previousPart = parts[partIndex - 1];
  if (previousPart?.type === "reasoning") return null;

  const combined = collectReasoningText(parts, partIndex);

  // Don't show reasoning if empty or only contains [REDACTED] (encrypted reasoning from providers like Gemini)
  if (!combined || combined.trim() === "[REDACTED]") return null;

  if (!combined && status !== "streaming") return null;

  const isLastPart = partIndex === parts.length - 1;
  const autoOpen =
    status === "streaming" && isLastPart && Boolean(isLastMessage);

  return (
    <Reasoning className="w-full" isStreaming={autoOpen}>
      <ReasoningTrigger />
      {combined && (
        <ReasoningContent>
          <MemoizedMarkdown content={combined} />
        </ReasoningContent>
      )}
    </Reasoning>
  );
};
