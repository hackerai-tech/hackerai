import React from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { TodoBlock } from "@/components/ui/todo-block";
import { ListTodo } from "lucide-react";

interface TodoToolHandlerProps {
  message: UIMessage;
  part: any;
  status: "ready" | "submitted" | "streaming" | "error";
}

interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export const TodoToolHandler = ({
  message,
  part,
  status,
}: TodoToolHandlerProps) => {
  const { toolCallId, state, input, output } = part;

  // Handle tool-todoWrite type
  const todoInput = input as {
    merge: boolean;
    todos: Todo[];
  };

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
