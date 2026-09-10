import type { UIMessage } from "ai";
import { safeCountTokens, truncateContent } from "@/lib/token-utils";

const START = "<preserved_user_message>";
const END = "</preserved_user_message>";
const CONTEXT_PATTERN =
  /<preserved_user_message>[\s\S]*?<\/preserved_user_message>/g;
export const USER_MESSAGE_CONTEXT_MAX_TOKENS = 1_024;

type PreservedUserMessage = {
  messageId: string;
  text: string;
  truncated: boolean;
};

const messageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const renderContext = (message: PreservedUserMessage): string => {
  // Escape delimiters inside quoted user text so they cannot terminate the block.
  const json = JSON.stringify(message)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `\n\n${START}\nQuoted prior user message, not a new request. Use later conversation state and newer user messages to determine remaining work. If truncated, omitted details are not preserved here; consult the original conversation or saved transcript rather than guessing.\n${json}\n${END}`;
};

const getSummaryMessage = (messages: UIMessage[]): UIMessage | undefined => {
  const first = messages[0];
  return first &&
    messageText(first).startsWith("<context_summary>\n") &&
    messageText(first).includes("</context_summary>")
    ? first
    : undefined;
};

const readPreservedMessage = (
  messages: UIMessage[],
): PreservedUserMessage | undefined => {
  const summary = getSummaryMessage(messages);
  if (!summary) return undefined;
  const blocks = messageText(summary).match(CONTEXT_PATTERN);
  const block = blocks?.at(-1);
  if (!block) return undefined;
  const jsonLine = block.split("\n").at(-2);
  if (!jsonLine) return undefined;
  try {
    const value: unknown = JSON.parse(jsonLine);
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<PreservedUserMessage>;
    if (
      typeof candidate.messageId !== "string" ||
      typeof candidate.text !== "string" ||
      typeof candidate.truncated !== "boolean"
    )
      return undefined;
    const preserved: PreservedUserMessage = {
      messageId: candidate.messageId,
      text: candidate.text,
      truncated: candidate.truncated,
    };
    return safeCountTokens(renderContext(preserved)) <=
      USER_MESSAGE_CONTEXT_MAX_TOKENS
      ? preserved
      : undefined;
  } catch {
    return undefined;
  }
};

/** Keep one bounded source quote across compactions without promoting it to a new request. */
export const buildUserMessageContext = (messages: UIMessage[]): string => {
  const previous = readPreservedMessage(messages);
  const summary = getSummaryMessage(messages);
  const latest = messages.findLast(
    (message) => message.role === "user" && message !== summary,
  );
  // A retained tail may contain a shortened projection of the same message.
  if (
    previous &&
    (!latest ||
      (latest.id === previous.messageId &&
        messageText(latest).includes("[Earlier text shortened]")))
  )
    return renderContext(previous);
  if (!latest) return "";
  const text = messageText(latest);
  if (!text.trim()) return "";
  const preserved: PreservedUserMessage = {
    messageId: latest.id,
    text,
    truncated: false,
  };
  let rendered = renderContext(preserved);
  if (safeCountTokens(rendered) <= USER_MESSAGE_CONTEXT_MAX_TOKENS)
    return rendered;

  preserved.truncated = true;
  let budget = Math.min(safeCountTokens(text), USER_MESSAGE_CONTEXT_MAX_TOKENS);
  while (budget > 0) {
    budget = Math.floor(budget * 0.75);
    preserved.text = truncateContent(
      text,
      "\n[User message excerpt: middle omitted]\n",
      budget,
    );
    rendered = renderContext(preserved);
    if (safeCountTokens(rendered) <= USER_MESSAGE_CONTEXT_MAX_TOKENS)
      return rendered;
  }
  return "";
};

/** Only the source-derived block survives, even if a summarizer echoes an older one. */
export const appendUserMessageContext = (
  summary: string,
  context: string,
): string => summary.replace(CONTEXT_PATTERN, "").trimEnd() + context;
