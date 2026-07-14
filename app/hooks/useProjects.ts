"use client";

import {
  useConvexAuth,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export const useProjects = () => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return useQuery(
    api.projects.listProjects,
    !isLoading && isAuthenticated ? {} : "skip",
  );
};

export const useProjectThreads = (
  projectId: Id<"projects">,
  shouldFetch = true,
) => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return usePaginatedQuery(
    api.projects.getProjectThreads,
    shouldFetch && !isLoading && isAuthenticated ? { projectId } : "skip",
    { initialNumItems: 5 },
  );
};

export const useCreateProject = () => useMutation(api.projects.createProject);

export const useMoveChatToProject = () =>
  useMutation(api.chats.moveChatToProject);
