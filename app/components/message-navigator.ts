import type { ChatMessage } from "@/types";
import { extractMessageText } from "@/lib/utils/message-utils";
import type { ChatTimelineRow } from "./message-timeline-rows";

export const MESSAGE_NAVIGATOR_MIN_ITEMS = 2;
export const MESSAGE_NAVIGATOR_ITEM_SPACING = 11;
export const MESSAGE_NAVIGATOR_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const MESSAGE_NAVIGATOR_CONTENT_MAX_WIDTH = 768;
export const MESSAGE_NAVIGATOR_PERSISTENT_GUTTER = 48;
export const MESSAGE_NAVIGATOR_HIT_STRIP_LEFT = 12;
export const MESSAGE_NAVIGATOR_HIT_STRIP_MAX_WIDTH = 40;

export interface MessageNavigatorItem {
  id: string;
  rowIndex: number;
  userText: string | null;
  assistantText: string | null;
}

const compactPreview = (text: string | null | undefined) => {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
};

export function deriveMessageNavigatorItems(
  messages: ReadonlyArray<ChatMessage>,
  timelineRows: ReadonlyArray<ChatTimelineRow>,
): MessageNavigatorItem[] {
  const rowIndexByMessageId = new Map<string, number>();
  for (let index = 0; index < timelineRows.length; index += 1) {
    const row = timelineRows[index];
    if (row?.kind === "message") {
      rowIndexByMessageId.set(row.message.id, index);
    }
  }

  const items: MessageNavigatorItem[] = [];
  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const message = messages[messageIndex];
    if (message?.role !== "user") {
      continue;
    }

    const rowIndex = rowIndexByMessageId.get(message.id);
    if (rowIndex === undefined) {
      continue;
    }

    let assistantText: string | null = null;
    for (
      let responseIndex = messageIndex + 1;
      responseIndex < messages.length;
      responseIndex += 1
    ) {
      const response = messages[responseIndex];
      if (!response || response.role === "user") {
        break;
      }
      if (response.role === "assistant") {
        assistantText = compactPreview(extractMessageText(response.parts));
      }
    }

    items.push({
      id: message.id,
      rowIndex,
      userText: compactPreview(extractMessageText(message.parts)),
      assistantText,
    });
  }

  return items;
}

export function resolveMessageNavigatorHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(
    1,
    (itemCount - 1) * MESSAGE_NAVIGATOR_ITEM_SPACING,
  );
  return `min(${naturalHeight}px, ${MESSAGE_NAVIGATOR_MAX_HEIGHT_CSS})`;
}

export function resolveMessageNavigatorTopPercent(
  index: number,
  itemCount: number,
): number {
  if (itemCount <= 1) {
    return 0;
  }

  const boundedIndex = Math.max(0, Math.min(index, itemCount - 1));
  return (boundedIndex / (itemCount - 1)) * 100;
}

export function resolveMessageNavigatorIndexFromPointer(input: {
  itemCount: number;
  railTop: number;
  railHeight: number;
  pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(
    0,
    Math.min(1, (input.pointerY - input.railTop) / input.railHeight),
  );
  return Math.max(
    0,
    Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))),
  );
}

export function resolveMessageNavigatorHasPersistentGutter(
  viewportWidth: number,
): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(
    viewportWidth,
    MESSAGE_NAVIGATOR_CONTENT_MAX_WIDTH,
  );
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= MESSAGE_NAVIGATOR_PERSISTENT_GUTTER;
}

export function resolveMessageNavigatorHitStripWidth(
  viewportWidth: number,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(
    viewportWidth,
    MESSAGE_NAVIGATOR_CONTENT_MAX_WIDTH,
  );
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      MESSAGE_NAVIGATOR_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - MESSAGE_NAVIGATOR_HIT_STRIP_LEFT,
    ),
  );
}
