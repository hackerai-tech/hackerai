import React, { createContext, useContext } from "react";

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
  return (
    <FileUrlCacheContext.Provider value={{ getCachedUrl, setCachedUrl }}>
      {children}
    </FileUrlCacheContext.Provider>
  );
}

export function useFileUrlCacheContext() {
  return useContext(FileUrlCacheContext);
}
