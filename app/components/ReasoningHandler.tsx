"use client";

import { UIMessage } from "@ai-sdk/react";
import type { ChatStatus } from "@/types";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { ShimmerText } from "./ShimmerText";

type ReasoningHandlerProps = {
  message: UIMessage;
  partIndex: number;
  status: ChatStatus;
};

type Step = { label: string; body: string };

const HEADER_MAX_LENGTH = 80;
const HEADING_REGEX = /\*\*([^*]+)\*\*\n\n/g;

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

const hasActiveReasoning = (
  parts: UIMessage["parts"],
  startIndex: number,
): boolean => {
  for (let i = startIndex; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type === "reasoning") {
      if (part.state !== "done") return true;
    } else {
      break;
    }
  }
  return false;
};

const parseSteps = (text: string): Step[] => {
  const steps: Step[] = [];
  const matches: Array<{ label: string; start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = HEADING_REGEX.exec(text)) !== null) {
    matches.push({
      label: match[1]?.trim() || "",
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (matches.length > 0) {
    matches.forEach((current, i) => {
      const next = matches[i + 1];
      const body = text.slice(current.end, next?.start || text.length).trim();
      steps.push({ label: current.label, body });
    });
  } else {
    const firstLine = text.split(/\n+/)[0]?.trim() || "Reasoning";
    steps.push({
      label: firstLine.slice(0, HEADER_MAX_LENGTH),
      body: text,
    });
  }

  return steps;
};

const getHeaderText = (steps: Step[], status: ChatStatus): string => {
  if (status !== "streaming") return "Chain of Thought";

  const lastStep = steps[steps.length - 1];
  const label = lastStep?.label.replace(/\*\*/g, "") || "Reasoning";
  return label.slice(0, HEADER_MAX_LENGTH);
};

export const ReasoningHandler = ({
  message,
  partIndex,
  status,
}: ReasoningHandlerProps) => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const currentPart = parts[partIndex];

  if (currentPart?.type !== "reasoning") return null;

  // Skip if previous part is also reasoning (avoid duplicate renders)
  const previousPart = parts[partIndex - 1];
  if (previousPart?.type === "reasoning") return null;

  const combined = collectReasoningText(parts, partIndex);
  const trimmedContent = combined.trim();

  // Show thinking placeholder if no content but actively reasoning
  if (
    !trimmedContent &&
    status === "streaming" &&
    hasActiveReasoning(parts, partIndex)
  ) {
    return (
      <div className="text-base text-muted-foreground py-2">
        <ShimmerText>Thinking…</ShimmerText>
      </div>
    );
  }

  if (!trimmedContent) return null;

  const steps = parseSteps(combined);
  const headerText = getHeaderText(steps, status);

  return (
    <ChainOfThought defaultOpen={false}>
      <ChainOfThoughtHeader>{headerText}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {steps.map((step, idx) => {
          const isLast = idx === steps.length - 1;
          const stepStatus =
            isLast && status === "streaming" ? "active" : "complete";

          return (
            <ChainOfThoughtStep
              key={`${message.id}-reasoning-step-${idx}`}
              label={step.label}
              status={stepStatus}
            >
              <MemoizedMarkdown content={step.body} />
            </ChainOfThoughtStep>
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
};
