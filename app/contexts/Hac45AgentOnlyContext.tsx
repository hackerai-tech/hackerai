"use client";

import { createContext, useContext } from "react";

export const Hac45AgentOnlyContext = createContext(false);

export function useHac45AgentOnlyTreatment(): boolean {
  return useContext(Hac45AgentOnlyContext);
}
