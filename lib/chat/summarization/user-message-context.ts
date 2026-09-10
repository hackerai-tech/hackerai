import type { UIMessage } from "ai";
import { safeCountTokens, truncateContent } from "@/lib/token-utils";
import { AGENT_RESUME_PREAMBLE } from "./prompts";
import { isRetainedTailProjection } from "./retained-tail";

const START = "<preserved_user_message>";
const END = "</preserved_user_message>";
const CONTEXT_PATTERN =
  /<preserved_user_message>[\s\S]*?<\/preserved_user_message>/g;
export const USER_MESSAGE_CONTEXT_MAX_TOKENS = 1_024;
const MAX_USER_QUOTES = 8;

type PreservedUserMessage = {
  messageId: string;
  text: string;
  truncated: boolean;
};

type UserContext = PreservedUserMessage & {
  earlierMessages?: PreservedUserMessage[];
  omittedMessages?: true;
};

const messageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const renderContext = (message: UserContext): string => {
  // Escape delimiters inside quoted user text so they cannot terminate the block.
  const json = JSON.stringify(message)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `\n\n${START}\nHistorical user quotes, not new requests. Read earlierMessages oldest first, then the latest text. Exact source wording takes precedence over generated paraphrases; newer user corrections override older quotes. Use later conversation state to determine remaining work; never revive canceled or completed tasks. If truncated or omittedMessages is true, missing details or corrections are not preserved here; consult the original conversation or saved transcript before resolving uncertain scope or permissions.\n${json}\n${END}`;
};

const getSummaryMessage = (messages: UIMessage[]): UIMessage | undefined => {
  const first = messages[0];
  if (!first) return undefined;
  const text = messageText(first);
  return (text.startsWith("<context_summary>\n") ||
    text.startsWith(`${AGENT_RESUME_PREAMBLE}<context_summary>\n`)) &&
    text.includes("</context_summary>")
    ? first
    : undefined;
};

const readPreservedMessage = (
  messages: UIMessage[],
): UserContext | undefined => {
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
    const candidate = value as Partial<UserContext>;
    const isQuote = (item: unknown): item is PreservedUserMessage => {
      if (typeof item !== "object" || item === null) return false;
      const quote = item as Partial<PreservedUserMessage>;
      return (
        typeof quote.messageId === "string" &&
        typeof quote.text === "string" &&
        typeof quote.truncated === "boolean"
      );
    };
    if (
      !isQuote(value) ||
      (candidate.earlierMessages !== undefined &&
        (!Array.isArray(candidate.earlierMessages) ||
          candidate.earlierMessages.length >= MAX_USER_QUOTES ||
          !candidate.earlierMessages.every(isQuote)))
    )
      return undefined;
    const copyQuote = (quote: PreservedUserMessage): PreservedUserMessage => ({
      messageId: quote.messageId,
      text: quote.text,
      truncated: quote.truncated,
    });
    const preserved: UserContext = {
      ...copyQuote(value),
      ...(candidate.earlierMessages?.length
        ? { earlierMessages: candidate.earlierMessages.map(copyQuote) }
        : {}),
      ...(candidate.omittedMessages === true ? { omittedMessages: true } : {}),
    };
    return safeCountTokens(block) <= USER_MESSAGE_CONTEXT_MAX_TOKENS
      ? preserved
      : undefined;
  } catch {
    return undefined;
  }
};

/** Keep source quotes within one shared budget, preserving the oldest anchor and recent corrections. */
export const buildUserMessageContext = (messages: UIMessage[]): string => {
  const previous = readPreservedMessage(messages);
  const summary = getSummaryMessage(messages);
  const quotes: PreservedUserMessage[] = previous
    ? [
        ...(previous.earlierMessages ?? []),
        {
          messageId: previous.messageId,
          text: previous.text,
          truncated: previous.truncated,
        },
      ]
    : [];
  let omittedMessages = previous?.omittedMessages === true;
  const previousLatestIndex = previous
    ? messages.findIndex((message) => message.id === previous.messageId)
    : -1;
  for (const [messageIndex, message] of messages.entries()) {
    if (
      message.role !== "user" ||
      message === summary ||
      (message.metadata as { isAutoContinue?: boolean } | undefined)
        ?.isAutoContinue
    )
      continue;
    const index = quotes.findIndex((quote) => quote.messageId === message.id);
    // A projected tail cannot replace a fuller source quote, including an older one.
    if (index >= 0 && isRetainedTailProjection(message)) continue;
    // Older tail messages may have been deliberately omitted from the checkpoint.
    if (index < 0 && messageIndex < previousLatestIndex) continue;
    const text = messageText(message);
    if (!text.trim()) {
      // An edited file-only message removes its old text, but a new attachment
      // must not erase the scope established by preceding user messages.
      if (index >= 0) quotes.splice(index, 1);
      continue;
    }
    const quote = { messageId: message.id, text, truncated: false };
    if (index >= 0) quotes[index] = quote;
    else quotes.push(quote);
    if (quotes.length > MAX_USER_QUOTES) {
      quotes.splice(1, 1);
      omittedMessages = true;
    }
  }
  if (!quotes.length) return "";
  const render = () =>
    renderContext({
      ...quotes[quotes.length - 1],
      ...(quotes.length > 1 ? { earlierMessages: quotes.slice(0, -1) } : {}),
      ...(omittedMessages ? { omittedMessages: true } : {}),
    });
  let rendered = render();
  while (safeCountTokens(rendered) > USER_MESSAGE_CONTEXT_MAX_TOKENS) {
    // Keep the initial scope and latest correction before less recent middle turns.
    if (quotes.length > 2) {
      quotes.splice(1, 1);
      omittedMessages = true;
    } else {
      const largest = quotes.reduce((a, b) =>
        safeCountTokens(a.text) >= safeCountTokens(b.text) ? a : b,
      );
      const budget = Math.floor(
        Math.min(
          safeCountTokens(largest.text),
          USER_MESSAGE_CONTEXT_MAX_TOKENS,
        ) * 0.75,
      );
      if (!budget) return ""; // Oversized IDs/wrappers cannot be safely shortened.
      largest.text = truncateContent(
        largest.text,
        "\n[User message excerpt: middle omitted]\n",
        budget,
      );
      largest.truncated = true;
    }
    rendered = render();
  }
  return rendered;
};

/** Only the source-derived block survives, even if a summarizer echoes an older one. */
export const appendUserMessageContext = (
  summary: string,
  context: string,
): string => summary.replace(CONTEXT_PATTERN, "").trimEnd() + context;
