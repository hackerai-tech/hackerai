import React, { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ListTodo, CircleArrowRight, ChevronsUpDown } from "lucide-react";
import type { TodoBlockProps } from "@/types";
import { useTodoBlockContext } from "@/app/contexts/TodoBlockContext";
import { SharedTodoItem } from "@/components/ui/shared-todo-item";
import {
  getTodoDisplayData,
  getVisibleTodoBlockItems,
} from "@/lib/utils/todo-utils";

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
    return getTodoDisplayData(todos);
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

  const visibleTodos = useMemo(
    () =>
      getVisibleTodoBlockItems({
        todos,
        inputTodos,
        showAllTodos,
      }),
    [inputTodos, showAllTodos, todos],
  );

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
            {isExpanded && headerContent.showViewAll && (
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
            {visibleTodos.map((todo) => (
              <SharedTodoItem key={todo.id} todo={todo} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
