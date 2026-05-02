import React from "react";
import {
  CircleCheck,
  Clock,
  CircleArrowRight,
  CirclePause,
  X,
} from "lucide-react";
import type { Todo } from "@/types";

export type TodoDisplayStatus = Todo["status"] | "paused";

export const STATUS_ICONS = {
  completed: <CircleCheck className="w-4 h-4 text-foreground" />,
  in_progress: <CircleArrowRight className="w-4 h-4 text-foreground" />,
  paused: <CirclePause className="w-4 h-4 text-muted-foreground" />,
  cancelled: <X className="w-4 h-4 text-muted-foreground" />,
  pending: <Clock className="w-4 h-4 text-muted-foreground" />,
} as const;

export const getStatusIcon = (status: TodoDisplayStatus) =>
  STATUS_ICONS[status] || STATUS_ICONS.pending;

export const getTextStyles = (status: TodoDisplayStatus) => {
  if (status === "completed") {
    return "line-through opacity-75 text-foreground";
  }
  if (status === "in_progress") {
    return "text-foreground font-medium";
  }
  return "text-muted-foreground";
};

export const SharedTodoItem = React.memo(
  ({ todo, isPaused = false }: { todo: Todo; isPaused?: boolean }) => {
    const displayStatus: TodoDisplayStatus =
      isPaused && todo.status === "in_progress" ? "paused" : todo.status;
    return (
      <div
        data-testid="todo-item"
        data-status={displayStatus}
        className="flex items-center gap-3 py-1"
      >
        <div className="flex-shrink-0">{getStatusIcon(displayStatus)}</div>
        <span className={`text-sm ${getTextStyles(displayStatus)}`}>
          {todo.content}
        </span>
      </div>
    );
  },
);

SharedTodoItem.displayName = "SharedTodoItem";
