"use client";

import { useState, useCallback } from "react";

interface TodoBlockState {
  autoId: string | null;
  manualIds: string[];
}

interface TodoBlockManager {
  messageTodoOpen: Record<string, TodoBlockState>;
  autoOpenTodoBlock: (messageId: string, blockId: string) => void;
  toggleTodoBlock: (messageId: string, blockId: string) => void;
  isBlockExpanded: (messageId: string, blockId: string) => boolean;
}

export const useTodoBlockManager = (): TodoBlockManager => {
  const [messageTodoOpen, setMessageTodoOpen] = useState<
    Record<string, TodoBlockState>
  >({});

  const autoOpenTodoBlock = useCallback(
    (messageId: string, blockId: string) => {
      setMessageTodoOpen((prev) => {
        const current = prev[messageId] || { autoId: null, manualIds: [] };
        if (current.autoId === blockId) {
          return prev; // no change
        }
        // Only the latest autoId stays open automatically. Manual opens persist.
        return {
          ...prev,
          [messageId]: { autoId: blockId, manualIds: current.manualIds },
        };
      });
    },
    [],
  );

  const toggleTodoBlock = useCallback((messageId: string, blockId: string) => {
    setMessageTodoOpen((prev) => {
      const current = prev[messageId] || { autoId: null, manualIds: [] };
      const isManual = current.manualIds.includes(blockId);
      const isAuto = current.autoId === blockId;

      if (isManual) {
        // Remove from manual list
        const nextManual = current.manualIds.filter((id) => id !== blockId);
        return {
          ...prev,
          [messageId]: { autoId: current.autoId, manualIds: nextManual },
        };
      } else if (isAuto) {
        // Close auto-opened block by clearing autoId
        return {
          ...prev,
          [messageId]: { autoId: null, manualIds: current.manualIds },
        };
      } else {
        // Add to manual list
        const nextManual = [...current.manualIds, blockId];
        return {
          ...prev,
          [messageId]: { autoId: current.autoId, manualIds: nextManual },
        };
      }
    });
  }, []);

  const isBlockExpanded = useCallback(
    (messageId: string, blockId: string): boolean => {
      const stateForMessage = messageTodoOpen[messageId] || {
        autoId: null,
        manualIds: [],
      };
      return (
        stateForMessage.autoId === blockId ||
        stateForMessage.manualIds.includes(blockId)
      );
    },
    [messageTodoOpen],
  );

  return {
    messageTodoOpen,
    autoOpenTodoBlock,
    toggleTodoBlock,
    isBlockExpanded,
  };
};
