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
  pendingRead: number;
};
type Update = {
  sequence: number;
  status?: Status;
  confirming?: boolean;
  checkedScope?: object;
  invalidate?: boolean;
};
const defaultScope = {};

function reduce(state: State, update: Update): State {
  if (update.invalidate) return { ...state, pendingRead: update.sequence };
  // A newer POST owns availability, but a panel's older GET can still finish
  // its freshness check. An even older panel cannot replace a newer read.
  const checkedScope =
    update.checkedScope && update.sequence >= state.checkedScopeSequence
      ? {
          checkedScope: update.checkedScope,
          checkedScopeSequence: update.sequence,
        }
      : {};
  const pendingRead =
    update.confirming !== undefined ||
    (update.checkedScope && update.sequence >= state.pendingRead)
      ? 0
      : state.pendingRead;
  if (update.sequence < state.sequence)
    return { ...state, ...checkedScope, pendingRead };
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
    pendingRead,
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
    pendingRead: 0,
  });
  const beginRead = useCallback((invalidate = false) => {
    const read = ++sequence.current;
    if (invalidate) dispatch({ sequence: read, invalidate: true });
    return read;
  }, []);
  const finishRead = useCallback(
    (read: number, status?: Status) => {
      dispatch({ sequence: read, status, checkedScope: scope });
    },
    [scope],
  );
  const recordDecision = useCallback((status?: Status) => {
    // Every successful POST can observe a concurrent recovery. Its result is
    // newer than reads issued before it settled, including decline/reopen.
    dispatch({
      sequence: ++sequence.current,
      status,
      confirming: confirming.current,
    });
  }, []);
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
      : state.pendingRead !== 0 ||
          state.availability === "unknown" ||
          state.checkedScope !== scope
        ? "Checking Cloud workspace status"
        : undefined;
  return useMemo(
    () => ({
      beginRead,
      finishRead,
      beginConfirmation,
      recordDecision,
      sendDisabledReason,
      recoveryStarted: state.confirming || state.availability === "held",
    }),
    [
      beginRead,
      finishRead,
      beginConfirmation,
      recordDecision,
      sendDisabledReason,
      state,
    ],
  );
}

export const CloudRecoveryAdmissionContext = createContext<
  ReturnType<typeof useCloudRecoveryAdmission> | undefined
>(undefined);
