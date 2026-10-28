"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
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

const ComposerGoalContext = createContext<
  | {
      draftId: { id: string; generation?: number } | null;
      setDraftId: Dispatch<
        SetStateAction<{ id: string; generation?: number } | null>
      >;
    }
  | undefined
>(undefined);

export function ComposerStateProvider({ children }: { children: ReactNode }) {
  const [input, setInputState] = useState("");
  const inputRef = useRef(input);
  const [goalDraftId, setGoalDraftId] = useState<{
    id: string;
    generation?: number;
  } | null>(null);
  const goal = useMemo(
    () => ({ draftId: goalDraftId, setDraftId: setGoalDraftId }),
    [goalDraftId],
  );

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
        <ComposerGoalContext.Provider value={goal}>
          {children}
        </ComposerGoalContext.Provider>
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

// New-chat composers move between centered and bottom placement at mobile
// breakpoints. Keep goal intent with the draft across those component remounts.
export function useComposerGoalMode(draftId: string) {
  const goal = useContext(ComposerGoalContext);
  if (goal === undefined) {
    throw new Error(
      "useComposerGoalMode must be used within a ComposerStateProvider",
    );
  }
  const { setDraftId } = goal;
  const setGoalMode = useCallback(
    (enabled: boolean, generation?: number) => {
      setDraftId((current) =>
        enabled
          ? { id: draftId, generation }
          : current?.id === draftId
            ? null
            : current,
      );
    },
    [draftId, setDraftId],
  );
  return [
    goal.draftId?.id === draftId,
    setGoalMode,
    goal.draftId?.id === draftId ? goal.draftId.generation : undefined,
  ] as const;
}
