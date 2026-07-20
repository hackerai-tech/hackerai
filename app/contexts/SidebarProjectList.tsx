"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PaginationStatus } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";

interface SidebarProjectListValue {
  projects: Doc<"projects">[] | undefined;
  paginationStatus?: PaginationStatus;
  loadMoreProjects?: (numItems: number) => void;
}

interface SidebarProjectListProviderProps extends SidebarProjectListValue {
  children: ReactNode;
}

const SidebarProjectListContext = createContext<SidebarProjectListValue>({
  projects: undefined,
});

export function SidebarProjectListProvider({
  children,
  projects,
  paginationStatus,
  loadMoreProjects,
}: SidebarProjectListProviderProps) {
  const value = useMemo(
    () => ({ projects, paginationStatus, loadMoreProjects }),
    [projects, paginationStatus, loadMoreProjects],
  );

  return (
    <SidebarProjectListContext.Provider value={value}>
      {children}
    </SidebarProjectListContext.Provider>
  );
}

export const useSidebarProjectList = () =>
  useContext(SidebarProjectListContext);
