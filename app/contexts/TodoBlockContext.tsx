"use client";

import React, { createContext, useContext, ReactNode, useMemo } from "react";
import { useTodoBlockManager } from "@/lib/utils/todo-block-manager";

interface TodoBlockContextType {
  autoOpenTodoBlock: (messageId: string, blockId: string) => void;
  toggleTodoBlock: (messageId: string, blockId: string) => void;
  isBlockExpanded: (messageId: string, blockId: string) => boolean;
}

const TodoBlockContext = createContext<TodoBlockContextType | undefined>(
  undefined,
);

interface TodoBlockProviderProps {
  children: ReactNode;
}

export const TodoBlockProvider: React.FC<TodoBlockProviderProps> = ({
  children,
}) => {
  const { autoOpenTodoBlock, toggleTodoBlock, isBlockExpanded } =
    useTodoBlockManager();

  const value: TodoBlockContextType = useMemo(
    () => ({
      autoOpenTodoBlock,
      toggleTodoBlock,
      isBlockExpanded,
    }),
    [autoOpenTodoBlock, toggleTodoBlock, isBlockExpanded],
  );

  return (
    <TodoBlockContext.Provider value={value}>
      {children}
    </TodoBlockContext.Provider>
  );
};

export const useTodoBlockContext = (): TodoBlockContextType => {
  const context = useContext(TodoBlockContext);
  if (context === undefined) {
    throw new Error(
      "useTodoBlockContext must be used within a TodoBlockProvider",
    );
  }
  return context;
};
