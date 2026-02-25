import type { UIMessageChunk } from "ai";
import type { Todo } from "@/types";
import { ERROR_NOTICE_MARKER } from "@/lib/constants/error-notice";

export { ERROR_NOTICE_MARKER };

const chunkMap = new Map<string, UIMessageChunk[]>();

export function appendChunk(chatId: string, chunk: UIMessageChunk): void {
  const existing = chunkMap.get(chatId);
  if (existing) {
    existing.push(chunk);
  } else {
    chunkMap.set(chatId, [chunk]);
  }
}

export function getChunks(chatId: string): UIMessageChunk[] {
  return chunkMap.get(chatId) ?? [];
}

export function clearChunks(chatId: string): void {
  chunkMap.delete(chatId);
}

// Todo state store: tracks the latest TodoManager state so catchError can persist it.
const todoStateMap = new Map<string, Todo[]>();

export function saveTodoState(chatId: string, todos: Todo[]): void {
  todoStateMap.set(chatId, todos);
}

export function getTodoState(chatId: string): Todo[] {
  return todoStateMap.get(chatId) ?? [];
}

export function clearTodoState(chatId: string): void {
  todoStateMap.delete(chatId);
}
