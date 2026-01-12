import React, { createContext, useContext, useMemo } from "react";

interface FileUrlCacheContextValue {
  getCachedUrl: (fileId: string) => string | null;
  setCachedUrl: (fileId: string, url: string) => void;
}

const FileUrlCacheContext = createContext<FileUrlCacheContextValue | null>(
  null,
);

export function FileUrlCacheProvider({
  children,
  getCachedUrl,
  setCachedUrl,
}: {
  children: React.ReactNode;
  getCachedUrl: (fileId: string) => string | null;
  setCachedUrl: (fileId: string, url: string) => void;
}) {
  // Memoize context value to prevent unnecessary re-renders of consumers
  // This is critical for preventing image flicker during streaming updates
  const contextValue = useMemo(
    () => ({ getCachedUrl, setCachedUrl }),
    [getCachedUrl, setCachedUrl],
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
