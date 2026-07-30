"use client";

import { useConvexAuth, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export const useProjects = (initialNumItems = 10) => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const shouldRunQuery = !isLoading && isAuthenticated;
  const query = usePaginatedQuery(
    api.projects.listProjects,
    shouldRunQuery ? {} : "skip",
    { initialNumItems },
  );

  return {
    ...query,
    results:
      shouldRunQuery && query.status !== "LoadingFirstPage"
        ? query.results
        : undefined,
  };
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

export const useUpdateProject = () => useMutation(api.projects.updateProject);

export const usePinProject = () => useMutation(api.projects.pinProject);

export const useUnpinProject = () => useMutation(api.projects.unpinProject);

export const useDeleteProject = () => useMutation(api.projects.deleteProject);

export const useMoveChatToProject = () =>
  useMutation(api.chats.moveChatToProject);
