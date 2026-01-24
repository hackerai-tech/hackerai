import { createChatHandler } from "@/lib/api/chat-handler";

export const maxDuration = 180;

export const POST = createChatHandler("/api/chat");
