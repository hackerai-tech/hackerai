"use client";

import { useState, useMemo } from "react";
import { ListTodo, CircleArrowRight, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SharedTodoItem } from "@/components/ui/shared-todo-item";
import {
  getTodoDisplayData,
  getVisibleTodoBlockItems,
} from "@/lib/utils/todo-utils";
import type { Todo } from "@/types";

interface SharedTodoBlockProps {
  todos: Todo[];
}

/**
 * Simplified TodoBlock for shared messages (no context dependency).
 * Mirrors the functionality of the main TodoBlock but works standalone.
 */
export const SharedTodoBlock = ({ todos }: SharedTodoBlockProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAllTodos, setShowAllTodos] = useState(false);

  const todoData = useMemo(() => {
    return getTodoDisplayData(todos);
  }, [todos]);

  const headerContent = useMemo(() => {
    const { currentInProgress, stats } = todoData;

    // When collapsed, show current in-progress task if available
    if (!isExpanded && currentInProgress) {
      return {
        text: currentInProgress.content,
        icon: (
          <CircleArrowRight className="text-foreground" aria-hidden="true" />
        ),
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
      icon: <ListTodo className="text-foreground" aria-hidden="true" />,
      showViewAll: stats.total > 1 && stats.done > 0,
    };
  }, [todoData, isExpanded]);

  const handleToggleExpanded = () => {
    setIsExpanded((prev) => !prev);
  };

  const handleToggleViewAll = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setShowAllTodos((prev) => !prev);
    if (!showAllTodos && !isExpanded) {
      setIsExpanded(true);
    }
  };

  const visibleTodos = useMemo(
    () =>
      getVisibleTodoBlockItems({
        todos,
        showAllTodos,
      }),
    [showAllTodos, todos],
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
              <button
                type="button"
                onClick={handleToggleViewAll}
                className="text-[12px] text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer p-1 ml-2 bg-transparent border-none"
              >
                {showAllTodos ? "Hide" : "View All"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-[4px]">
            <div className="w-[21px] inline-flex items-center flex-shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">
              <ChevronsUpDown aria-hidden="true" />
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
