"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { SidebarSubagentOrigin } from "@/types/chat";

const ToolSidebarOriginContext = createContext<
  SidebarSubagentOrigin | undefined
>(undefined);

export const ToolSidebarOriginProvider = ({
  children,
  origin,
}: {
  children: ReactNode;
  origin: SidebarSubagentOrigin;
}) => (
  <ToolSidebarOriginContext.Provider value={origin}>
    {children}
  </ToolSidebarOriginContext.Provider>
);

export const useToolSidebarOrigin = () => useContext(ToolSidebarOriginContext);
