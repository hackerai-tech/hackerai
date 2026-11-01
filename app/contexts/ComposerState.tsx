"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ComposerActions = {
  clearInput: () => void;
  getInput: () => string;
  setInput: (value: string) => void;
};

const ComposerInputContext = createContext<string | undefined>(undefined);
const ComposerActionsContext = createContext<ComposerActions | undefined>(
  undefined,
);

export function ComposerStateProvider({ children }: { children: ReactNode }) {
  const [input, setInputState] = useState("");
  const inputRef = useRef(input);

  const setInput = useCallback((value: string) => {
    inputRef.current = value;
    setInputState(value);
  }, []);

  const clearInput = useCallback(() => {
    inputRef.current = "";
    setInputState("");
  }, []);

  const getInput = useCallback(() => inputRef.current, []);
  const actions = useMemo(
    () => ({ clearInput, getInput, setInput }),
    [clearInput, getInput, setInput],
  );

  return (
    <ComposerActionsContext.Provider value={actions}>
      <ComposerInputContext.Provider value={input}>
        {children}
      </ComposerInputContext.Provider>
    </ComposerActionsContext.Provider>
  );
}

export function useComposerInput(): string {
  const input = useContext(ComposerInputContext);
  if (input === undefined) {
    throw new Error(
      "useComposerInput must be used within a ComposerStateProvider",
    );
  }
  return input;
}

export function useComposerActions(): ComposerActions {
  const actions = useContext(ComposerActionsContext);
  if (actions === undefined) {
    throw new Error(
      "useComposerActions must be used within a ComposerStateProvider",
    );
  }
  return actions;
}
