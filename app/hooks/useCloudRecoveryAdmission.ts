"use client";

import { createContext, useCallback, useMemo, useReducer, useRef } from "react";
import type { RecoveryView } from "@/lib/cloud-recovery/service";

type Status = RecoveryView["status"];
type State = {
  availability: "unknown" | "clear" | "held";
  sequence: number;
  confirming: boolean;
  checkedScope?: object;
  checkedScopeSequence: number;
};
type Update = {
  sequence: number;
  status?: Status;
  confirming?: boolean;
  checkedScope?: object;
};
const defaultScope = {};

function reduce(state: State, update: Update): State {
  // A newer POST owns availability, but a panel's older GET can still finish
  // its freshness check. An even older panel cannot replace a newer read.
  const checkedScope =
    update.checkedScope && update.sequence >= state.checkedScopeSequence
      ? {
          checkedScope: update.checkedScope,
          checkedScopeSequence: update.sequence,
        }
      : {};
  if (update.sequence < state.sequence) return { ...state, ...checkedScope };
  let availability = state.availability;
  switch (update.status) {
    case "recovering":
      availability = "held";
      break;
    case "hidden":
    case "recovered":
    case "offered":
    case "declined":
    case "waiting":
    case "support":
      availability = "clear";
      break;
    default:
      // A failed/malformed lookup is not proof that observed recovery finished.
      if (availability === "unknown") availability = "clear";
  }
  return {
    availability,
    sequence: update.sequence,
    confirming: update.confirming ?? state.confirming,
    checkedScope: state.checkedScope,
    checkedScopeSequence: state.checkedScopeSequence,
    ...checkedScope,
  };
}

/** One workspace gate outlives chat/panel remounts and orders both panels' reads. */
export function useCloudRecoveryAdmission(scope: object = defaultScope) {
  const sequence = useRef(0);
  const confirming = useRef(false);
  const [state, dispatch] = useReducer(reduce, {
    availability: "unknown",
    sequence: 0,
    confirming: false,
    checkedScopeSequence: 0,
  });
  const beginRead = useCallback(() => ++sequence.current, []);
  const finishRead = useCallback(
    (read: number, status?: Status) => {
      dispatch({ sequence: read, status, checkedScope: scope });
    },
    [scope],
  );
  const beginConfirmation = useCallback(() => {
    if (confirming.current) return;
    confirming.current = true;
    dispatch({ sequence: ++sequence.current, confirming: true });
    return (status: Status = "recovering") => {
      confirming.current = false;
      // Reads issued before the POST settled cannot unlock a newer recovery.
      dispatch({ sequence: ++sequence.current, status, confirming: false });
    };
  }, []);
  const sendDisabledReason = state.confirming
    ? "Starting Cloud workspace recovery"
    : state.availability === "held"
      ? "Cloud workspace recovery is in progress"
      : state.availability === "unknown" || state.checkedScope !== scope
        ? "Checking Cloud workspace status"
        : undefined;
  return useMemo(
    () => ({
      beginRead,
      finishRead,
      beginConfirmation,
      sendDisabledReason,
      recoveryStarted: state.confirming || state.availability === "held",
    }),
    [beginRead, finishRead, beginConfirmation, sendDisabledReason, state],
  );
}

export const CloudRecoveryAdmissionContext = createContext<
  ReturnType<typeof useCloudRecoveryAdmission> | undefined
>(undefined);
