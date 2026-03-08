"use client";

import React, { createContext, useContext, useMemo, useState } from "react";
import type { DataUIPart } from "ai";

interface DataStreamContextValue {
  dataStream: DataUIPart<any>[];
  setDataStream: React.Dispatch<React.SetStateAction<DataUIPart<any>[]>>;
  isAutoResuming: boolean;
  setIsAutoResuming: React.Dispatch<React.SetStateAction<boolean>>;
  autoContinueCount: number;
  setAutoContinueCount: React.Dispatch<React.SetStateAction<number>>;
}

const DataStreamContext = createContext<DataStreamContextValue | null>(null);

export function DataStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [dataStream, setDataStream] = useState<DataUIPart<any>[]>([]);
  const [isAutoResuming, setIsAutoResuming] = useState<boolean>(false);
  const [autoContinueCount, setAutoContinueCount] = useState<number>(0);

  const value = useMemo(
    () => ({
      dataStream,
      setDataStream,
      isAutoResuming,
      setIsAutoResuming,
      autoContinueCount,
      setAutoContinueCount,
    }),
    [dataStream, isAutoResuming, autoContinueCount],
  );

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

export function useDataStream() {
  const context = useContext(DataStreamContext);
  if (!context) {
    throw new Error("useDataStream must be used within a DataStreamProvider");
  }
  return context;
}
