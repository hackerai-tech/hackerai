import { ReactNode } from "react";

// Create stable mock references
const mockSetDataStream = jest.fn();
const mockSetIsAutoResuming = jest.fn();
const mockSetAutoContinueCount = jest.fn();

export const useDataStream = () => ({
  dataStream: [],
  isAutoResuming: false,
  autoContinueCount: 0,
  setDataStream: mockSetDataStream,
  setIsAutoResuming: mockSetIsAutoResuming,
  setAutoContinueCount: mockSetAutoContinueCount,
});

export const useDataStreamState = () => ({
  dataStream: [],
  isAutoResuming: false,
  autoContinueCount: 0,
});

export const useDataStreamDispatch = () => ({
  setDataStream: mockSetDataStream,
  setIsAutoResuming: mockSetIsAutoResuming,
  setAutoContinueCount: mockSetAutoContinueCount,
});

export const DataStreamProvider = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};
