"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";

export type ChatMode = "agent" | "ask";

interface GlobalStateType {
  // Input state
  input: string;
  setInput: (value: string) => void;

  // Mode state
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;

  // Chat title state
  chatTitle: string | null;
  setChatTitle: (title: string | null) => void;

  // Utility methods
  clearInput: () => void;
  resetChat: () => void;
}

const GlobalStateContext = createContext<GlobalStateType | undefined>(
  undefined,
);

interface GlobalStateProviderProps {
  children: ReactNode;
}

export const GlobalStateProvider: React.FC<GlobalStateProviderProps> = ({
  children,
}) => {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [chatTitle, setChatTitle] = useState<string | null>(null);

  const clearInput = () => {
    setInput("");
  };

  const resetChat = () => {
    setInput("");
    setChatTitle(null);
  };

  const value: GlobalStateType = {
    input,
    setInput,
    mode,
    setMode,
    chatTitle,
    setChatTitle,
    clearInput,
    resetChat,
  };

  return (
    <GlobalStateContext.Provider value={value}>
      {children}
    </GlobalStateContext.Provider>
  );
};

export const useGlobalState = (): GlobalStateType => {
  const context = useContext(GlobalStateContext);
  if (context === undefined) {
    throw new Error("useGlobalState must be used within a GlobalStateProvider");
  }
  return context;
};
