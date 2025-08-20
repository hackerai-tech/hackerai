import React, { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  X,
  CircleCheck,
  ListTodo,
  CircleArrowRight,
  Circle,
  ChevronsUpDown,
} from "lucide-react";
import type { Todo, TodoBlockProps } from "@/types";
import { useTodoBlockContext } from "@/app/contexts/TodoBlockContext";

const STATUS_ICONS = {
  completed: <CircleCheck className="w-4 h-4 text-foreground" />,
  in_progress: <CircleArrowRight className="w-4 h-4 text-foreground" />,
  cancelled: <X className="w-4 h-4 text-muted-foreground" />,
  pending: <Circle className="w-4 h-4 text-muted-foreground" />,
} as const;

const getStatusIcon = (status: Todo["status"]) =>
  STATUS_ICONS[status] || STATUS_ICONS.pending;

const TodoItem = React.memo(({ todo }: { todo: Todo }) => {
  const getTextStyles = () => {
    if (todo.status === "completed") {
      return "line-through opacity-75 text-foreground";
    }
    if (todo.status === "in_progress") {
      return "text-foreground font-medium";
    }
    return "text-muted-foreground";
  };

  return (
    <div className="rounded-[15px] px-[10px] py-[6px] border border-border bg-muted/20 flex w-full gap-[4px] items-center h-[36px]">
      <div className="w-[21px] flex items-center justify-center flex-shrink-0 text-foreground [&>svg]:h-4 [&>svg]:w-4">
        {getStatusIcon(todo.status)}
      </div>
      <div className="flex-1 truncate relative top-[-1px]">
        <span className={`text-[13px] ${getTextStyles()}`}>{todo.content}</span>
      </div>
    </div>
  );
});

TodoItem.displayName = "TodoItem";

export const TodoBlock = ({
  todos,
  inputTodos,
  blockId,
  messageId,
}: TodoBlockProps) => {
  const { autoOpenTodoBlock, toggleTodoBlock, isBlockExpanded } =
    useTodoBlockContext();
  const [showAllTodos, setShowAllTodos] = useState(false);

  // Determine if this block should be expanded based on todo block state
  const isExpanded = isBlockExpanded(messageId, blockId);

  // Auto-open this todo block when it's created (closes previous ones in same message)
  useEffect(() => {
    autoOpenTodoBlock(messageId, blockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, blockId]); // Only depend on messageId and blockId to prevent infinite loops

  const todoData = useMemo(() => {
    const byStatus = {
      completed: todos.filter((t) => t.status === "completed"),
      inProgress: todos.filter((t) => t.status === "in_progress"),
      pending: todos.filter((t) => t.status === "pending"),
      cancelled: todos.filter((t) => t.status === "cancelled"),
    };

    const stats = {
      total: todos.length,
      completed: byStatus.completed.length,
      inProgress: byStatus.inProgress.length,
      pending: byStatus.pending.length,
      cancelled: byStatus.cancelled.length,
      // Count both completed and cancelled as "done"
      done: byStatus.completed.length + byStatus.cancelled.length,
    };

    const currentInProgress = byStatus.inProgress[0];
    const lastCompleted = byStatus.completed[byStatus.completed.length - 1];
    const hasProgress = stats.done > 0;
    const allCompleted = stats.done === stats.total && stats.total > 0;

    return {
      byStatus,
      stats,
      currentInProgress,
      lastCompleted,
      hasProgress,
      allCompleted,
    };
  }, [todos]);

  const headerContent = useMemo(() => {
    const { currentInProgress, stats } = todoData;

    // When collapsed, show current in-progress task if available
    if (!isExpanded && currentInProgress) {
      return {
        text: currentInProgress.content,
        icon: <CircleArrowRight className="text-foreground" />,
        showViewAll: stats.total > 1 && stats.done > 0,
      };
    }

    // When expanded OR no in-progress task, show list-todo icon with progress text
    const progressText =
      stats.done === 0
        ? `To-dos (${stats.total})`
        : `${stats.done} of ${stats.total} Done`;

    return {
      text: progressText,
      icon: <ListTodo className="text-foreground" />,
      showViewAll: stats.total > 1 && stats.done > 0,
    };
  }, [todoData, isExpanded]);

  const handleToggleExpanded = () => {
    // Toggle this todo block (manual toggles persist and don't affect auto-opened one)
    toggleTodoBlock(messageId, blockId);
  };

  const handleToggleViewAll = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setShowAllTodos((prev) => !prev);
    if (!showAllTodos && !isExpanded) {
      // Promote to manual open if user wants to view all while collapsed
      toggleTodoBlock(messageId, blockId);
    }
  };

  const getVisibleTodos = () => {
    const { hasProgress, stats, currentInProgress } = todoData;

    if (!hasProgress || stats.done === 0) {
      return todos;
    }

    if (showAllTodos) {
      return todos;
    }

    // Show collapsed view: input todos + current in-progress
    const visibleTodos = [];

    // If we have inputTodos, show all of them (these are the todos being updated in this call)
    if (inputTodos && inputTodos.length > 0) {
      const inputTodoIds = new Set(inputTodos.map((t) => t.id));
      const inputTodosFromCurrent = todos.filter((todo) =>
        inputTodoIds.has(todo.id),
      );
      visibleTodos.push(...inputTodosFromCurrent);
    } else {
      // Fallback: show most recent completed/cancelled
      const { lastCompleted, byStatus } = todoData;
      const lastCancelled = byStatus.cancelled[byStatus.cancelled.length - 1];

      let mostRecentAction = null;
      if (lastCompleted && lastCancelled) {
        const completedIndex = todos.findIndex(
          (t) => t.id === lastCompleted.id,
        );
        const cancelledIndex = todos.findIndex(
          (t) => t.id === lastCancelled.id,
        );
        mostRecentAction =
          completedIndex > cancelledIndex ? lastCompleted : lastCancelled;
      } else {
        mostRecentAction = lastCompleted || lastCancelled;
      }

      if (mostRecentAction) {
        visibleTodos.push(mostRecentAction);
      }
    }

    // Always show current in-progress task if not already included
    if (
      currentInProgress &&
      !visibleTodos.some((t) => t.id === currentInProgress.id)
    ) {
      visibleTodos.push(currentInProgress);
    }

    // If no in-progress and no visible todos yet, show next pending
    if (!currentInProgress && visibleTodos.length === 0) {
      const nextPending = todos.find((todo) => todo.status === "pending");
      if (nextPending) {
        visibleTodos.push(nextPending);
      }
    }

    return visibleTodos;
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="rounded-[15px] border border-border bg-muted/20 overflow-hidden">
        {/* Header */}
        <Button
          variant="ghost"
          onClick={handleToggleExpanded}
          className="flex w-full items-center justify-between px-[10px] py-[6px] h-[36px] hover:bg-muted/40 transition-colors rounded-none"
          aria-label={isExpanded ? "Collapse todos" : "Expand todos"}
        >
          <div className="flex items-center gap-[4px]">
            <div className="w-[21px] inline-flex items-center flex-shrink-0 text-foreground [&>svg]:h-4 [&>svg]:w-4">
              {headerContent.icon}
            </div>
            <div className="max-w-[100%] truncate text-foreground relative top-[-1px]">
              <span className="text-[13px] font-medium">
                {headerContent.text}
              </span>
            </div>
            {headerContent.showViewAll && isExpanded && (
              <span
                onClick={handleToggleViewAll}
                className="text-[12px] text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer p-1 ml-2"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleToggleViewAll(e);
                  }
                }}
              >
                {showAllTodos ? "Hide" : "View All"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-[4px]">
            <div className="w-[21px] inline-flex items-center flex-shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">
              <ChevronsUpDown />
            </div>
          </div>
        </Button>

        {/* Expanded list */}
        {isExpanded && (
          <div className="border-t border-border p-2 space-y-2">
            {getVisibleTodos().map((todo) => (
              <TodoItem key={todo.id} todo={todo} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
