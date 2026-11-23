import { convertToModelMessages } from "ai";
import { splitAgentSteerMessages } from "@/lib/chat/agent-steer";

/**
 * `convertToModelMessages` with each mid-run steer as a user message where the
 * run read it. The SDK would keep a data part in the assistant's role, so the
 * split happens here, after every ID-based step has used the saved messages.
 */
export const convertToModelMessagesWithSteers = (
  messages: Parameters<typeof convertToModelMessages>[0],
  options?: Parameters<typeof convertToModelMessages>[1],
) => convertToModelMessages(splitAgentSteerMessages(messages), options);
