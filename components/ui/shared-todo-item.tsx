import React from "react";
import { CircleCheck, Circle, CircleArrowRight, X } from "lucide-react";
import type { Todo } from "@/types";

export const STATUS_ICONS = {
  completed: <CircleCheck className="w-4 h-4 text-foreground" />,
  in_progress: <CircleArrowRight className="w-4 h-4 text-foreground" />,
  cancelled: <X className="w-4 h-4 text-muted-foreground" />,
  pending: <Circle className="w-4 h-4 text-muted-foreground" />,
} as const;

export const getStatusIcon = (status: Todo["status"]) =>
  STATUS_ICONS[status] || STATUS_ICONS.pending;

export const getTextStyles = (status: Todo["status"]) => {
  if (status === "completed") {
    return "line-through opacity-75 text-foreground";
  }
  if (status === "in_progress") {
    return "text-foreground font-medium";
  }
  return "text-muted-foreground";
};

export const SharedTodoItem = React.memo(({ todo }: { todo: Todo }) => {
  return (
    <div
      data-testid="todo-item"
      data-status={todo.status}
      className="flex items-center gap-3 py-1"
    >
      <div className="flex-shrink-0">{getStatusIcon(todo.status)}</div>
      <span className={`text-sm ${getTextStyles(todo.status)}`}>
        {todo.content}
      </span>
    </div>
  );
});

SharedTodoItem.displayName = "SharedTodoItem";
