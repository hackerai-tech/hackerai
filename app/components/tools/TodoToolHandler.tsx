import React from "react";
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

export const TodoToolHandler = ({
  message,
  part,
  status,
}: TodoToolHandlerProps) => {
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
};
