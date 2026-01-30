import React, { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { TodoBlock } from "@/components/ui/todo-block";
import { ListTodo } from "lucide-react";
import type { ChatStatus, Todo, TodoWriteInput } from "@/types";

interface TodoToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}

// Custom comparison for todo handler
function areTodoPropsEqual(
  prev: TodoToolHandlerProps,
  next: TodoToolHandlerProps,
): boolean {
  if (prev.status !== next.status) return false;
  if (prev.part.state !== next.part.state) return false;
  if (prev.part.toolCallId !== next.part.toolCallId) return false;
  if (prev.part.output !== next.part.output) return false;
  if (prev.part.input !== next.part.input) return false;
  return true;
}

export const TodoToolHandler = memo(function TodoToolHandler({
  message,
  part,
  status,
}: TodoToolHandlerProps) {
  const { toolCallId, state, input, output } = part;
  const todoInput = input as TodoWriteInput;

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<ListTodo />}
          action="Creating to-do list"
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<ListTodo />}
          action={
            todoInput?.merge ? "Updating to-do list" : "Creating to-do list"
          }
          target={`${todoInput?.todos?.length || 0} items`}
          isShimmer={true}
        />
      ) : null;

    case "output-available": {
      const todoOutput = output as {
        result: string;
        counts: {
          completed: number;
          total: number;
        };
        currentTodos: Todo[];
      };

      return (
        <TodoBlock
          todos={todoOutput.currentTodos}
          inputTodos={todoInput?.todos}
          blockId={toolCallId}
          messageId={message.id}
        />
      );
    }

    default:
      return null;
  }
}, areTodoPropsEqual);
