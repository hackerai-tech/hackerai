import React, { createContext, useContext, useMemo } from "react";

interface FileUrlCacheContextValue {
  getCachedUrl: (fileId: string) => string | null;
  setCachedUrl: (fileId: string, url: string) => void;
  /**
   * Shared, batched URL request for an inline image. Resolves null when the
   * file is unavailable; rejects with an AbortError when authentication
   * changed first, after which a new function identity is provided.
   */
  loadImageUrl?: (fileId: string) => Promise<string | null>;
}

const FileUrlCacheContext = createContext<FileUrlCacheContextValue | null>(
  null,
);

export function FileUrlCacheProvider({
  children,
  getCachedUrl,
  setCachedUrl,
  loadImageUrl,
}: FileUrlCacheContextValue & { children: React.ReactNode }) {
  // Memoize context value to prevent unnecessary re-renders of consumers
  // This is critical for preventing image flicker during streaming updates
  const contextValue = useMemo(
    () => ({ getCachedUrl, setCachedUrl, loadImageUrl }),
    [getCachedUrl, setCachedUrl, loadImageUrl],
  );

  return (
    <FileUrlCacheContext.Provider value={contextValue}>
      {children}
    </FileUrlCacheContext.Provider>
  );
}

export function useFileUrlCacheContext() {
  return useContext(FileUrlCacheContext);
}
