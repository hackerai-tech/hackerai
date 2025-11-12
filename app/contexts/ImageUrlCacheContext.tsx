import React, { createContext, useContext } from "react";

interface ImageUrlCacheContextValue {
  getCachedUrl: (fileId: string) => string | null;
}

const ImageUrlCacheContext = createContext<ImageUrlCacheContextValue | null>(
  null,
);

export function ImageUrlCacheProvider({
  children,
  getCachedUrl,
}: {
  children: React.ReactNode;
  getCachedUrl: (fileId: string) => string | null;
}) {
  return (
    <ImageUrlCacheContext.Provider value={{ getCachedUrl }}>
      {children}
    </ImageUrlCacheContext.Provider>
  );
}

export function useImageUrlCacheContext() {
  return useContext(ImageUrlCacheContext);
}
