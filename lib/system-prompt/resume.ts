import {
  OUTPUT_LIMIT_FINISH_REASON,
  POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
} from "@/lib/chat/stop-conditions";

export const getResumeSection = (finishReason?: string): string => {
  if (finishReason === "tool-calls") {
    return `<resume_context>
Your previous response was interrupted during tool calls before completing the user's original request. \
The last user message in the conversation history contains the original task you were working on. \
If the user says "continue" or similar, resume executing that original task exactly where you left off. \
Follow through on the last user command autonomously without restarting or asking for direction.
</resume_context>`;
  } else if (finishReason === OUTPUT_LIMIT_FINISH_REASON) {
    return `<resume_context>
Your previous response was interrupted because it reached this turn's output token limit. \
The conversation was cut off mid-generation. If the user says "continue" or similar, seamlessly continue \
from where you left off. Pick up the thought, explanation, or task execution exactly where it stopped \
without repeating what was already said or restarting from the beginning. IMPORTANT: Divide your response \
into separate steps to avoid triggering the output limit again. Be more concise and focus on completing \
one step at a time rather than trying to output everything at once.
</resume_context>`;
  } else if (finishReason === "context-limit") {
    return `<resume_context>
Your previous response was stopped because the conversation's accumulated token usage exceeded \
the context limit, even after earlier messages were summarized. The context has been condensed \
but you may be missing details from the earlier conversation. If the user says "continue" or similar, \
resume the task where you left off. Do not restart the original task or repeat completed tool work. \
First inspect the latest assistant progress, todos, files, and current sandbox state when needed, then continue \
with only the remaining work. Consult the transcript file on the sandbox if you need to recover \
specific details from the earlier conversation.
</resume_context>`;
  } else if (finishReason === "preemptive-timeout") {
    return `<resume_context>
Your previous response was stopped because the streaming duration exceeded the server time limit. \
This is a normal operational limit, not an error. The conversation is intact and your work is preserved. \
Resume the task exactly where you left off without repeating what was already done.
</resume_context>`;
  } else if (finishReason === "agent-run-spend-cap") {
    return `<resume_context>
Your previous response was paused by a legacy Pro Agent per-run spend cap. \
This was a user cost-control pause, not a task failure. If the user says "continue" or similar, \
resume the task exactly where you left off without repeating what was already done.
</resume_context>`;
  } else if (finishReason === "budget-exhausted") {
    return `<resume_context>
Your previous response was paused because the monthly usage budget or extra usage spending limit was reached. \
This was a user cost-control pause, not a task failure. If the user says "continue" or similar, \
resume the task exactly where you left off without repeating completed work or starting the task over.
</resume_context>`;
  } else if (finishReason === POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON) {
    return `<resume_context>
Your previous response stopped immediately after conversation compaction before completing the user's original request. \
The context has been condensed. If the user says "continue" or similar, resume from the latest saved progress \
without acknowledging the compaction, restarting completed work, or saying that you will continue. \
Use tools when action is still needed; otherwise provide the final result or deliverable.
</resume_context>`;
  }

  return "";
};
